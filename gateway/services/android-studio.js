import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { execFileSync } from "child_process";
import os from "os";
import path from "path";
import { getConfig, updateConfig } from "./config.js";

function cleanPath(value, env = process.env) {
  let p = String(value || "").trim();
  if (!p) return "";
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, -1).trim();
  p = p.replace(/^file:\/\//i, "");
  p = p.replace(/%([^%]+)%/g, (m, name) => env[name] || env[name.toUpperCase()] || env[name.toLowerCase()] || m);
  if (p === "~") p = os.homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = path.join(os.homedir(), p.slice(2));
  return p;
}

function safeStat(p) {
  try { return statSync(p); } catch { return null; }
}

function addCandidate(list, p) {
  if (p && !list.includes(p)) list.push(p);
}

export function resolveAndroidStudioExecutable(value, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const input = cleanPath(value, env);
  if (!input) return null;

  const candidates = [];
  const ext = path.extname(input).toLowerCase();
  const base = path.basename(input).toLowerCase();
  const dir = path.dirname(input);

  if (platform === "win32") {
    const knownStudioBinary = base === "studio64.exe" || base === "studio.exe" || base === "studio.bat";
    if (base === "studio.exe") addCandidate(candidates, path.join(dir, "studio64.exe"));
    if (knownStudioBinary) addCandidate(candidates, input);
    if (ext) {
      addCandidate(candidates, path.join(dir, "bin", "studio64.exe"));
      addCandidate(candidates, path.join(dir, "bin", "studio.exe"));
      addCandidate(candidates, path.join(dir, "bin", "studio.bat"));
    }
    addCandidate(candidates, path.join(input, "bin", "studio64.exe"));
    addCandidate(candidates, path.join(input, "bin", "studio.exe"));
    addCandidate(candidates, path.join(input, "bin", "studio.bat"));
    if (base === "bin" || ext === "") {
      addCandidate(candidates, path.join(input, "studio64.exe"));
      addCandidate(candidates, path.join(input, "studio.exe"));
      addCandidate(candidates, path.join(input, "studio.bat"));
    }
  } else if (platform === "darwin") {
    addCandidate(candidates, input);
    addCandidate(candidates, path.join(input, "Android Studio.app"));
    addCandidate(candidates, path.join(input, "Android Studio Preview.app"));
  } else {
    addCandidate(candidates, input);
    addCandidate(candidates, path.join(input, "bin", "studio.sh"));
    if (base === "bin" || ext === "") addCandidate(candidates, path.join(input, "studio.sh"));
  }

  for (const candidate of candidates) {
    const st = safeStat(candidate);
    if (!st) continue;
    if (platform === "darwin" && /\.app$/i.test(candidate) && st.isDirectory()) return candidate;
    if (st.isFile()) return candidate;
  }
  return null;
}

function listDirs(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listFilesRecursive(root, predicate, limit = 100) {
  const out = [];
  const visit = (dir) => {
    if (out.length >= limit) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && predicate(full, entry.name)) out.push(full);
    }
  };
  if (root && existsSync(root)) visit(root);
  return out;
}

function scanAndroidRoot(androidRoot, add) {
  for (const name of listDirs(androidRoot)) {
    if (!/^Android Studio/i.test(name)) continue;
    add(path.join(androidRoot, name, "bin", "studio64.exe"), name, "scan");
    add(path.join(androidRoot, name, "bin", "studio.exe"), name, "scan");
  }
}

function resolveWindowsShortcutTargets(shortcutPaths, env = process.env) {
  if (!shortcutPaths.length || process.platform !== "win32") return [];
  try {
    const script = [
      "$links = ConvertFrom-Json $env:AIDEV_STUDIO_LINKS",
      "$shell = New-Object -ComObject WScript.Shell",
      "$out = @()",
      "foreach ($link in $links) {",
      "  try {",
      "    $shortcut = $shell.CreateShortcut([string]$link)",
      "    if ($shortcut.TargetPath) { $out += [pscustomobject]@{ target = $shortcut.TargetPath; args = $shortcut.Arguments } }",
      "  } catch {}",
      "}",
      "$out | ConvertTo-Json -Compress",
    ].join("\n");
    const stdout = execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-Command", script,
    ], {
      encoding: "utf8",
      env: { ...env, AIDEV_STUDIO_LINKS: JSON.stringify(shortcutPaths) },
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout || "[]");
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map((item) => String(item?.target || "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function scanWindowsShortcuts(add, env, options = {}) {
  const shortcutTargets = Array.isArray(options.shortcutTargets)
    ? options.shortcutTargets
    : null;
  const targets = shortcutTargets || (() => {
    const roots = [
      env.APPDATA && path.join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
      env.ProgramData && path.join(env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs"),
      env.USERPROFILE && path.join(env.USERPROFILE, "Desktop"),
      env.PUBLIC && path.join(env.PUBLIC, "Desktop"),
    ].filter(Boolean);
    const links = roots.flatMap((root) => listFilesRecursive(
      root,
      (_full, name) => /android studio.*\.lnk$/i.test(name),
      200,
    ));
    return resolveWindowsShortcutTargets(links, env);
  })();
  for (const target of targets) add(target, "Windows shortcut", "shortcut");
}

function commandPathCandidates(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const out = [];
  const add = (candidate) => {
    const cleaned = cleanPath(String(candidate || "").trim().replace(/,\d+$/, ""));
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
  };

  add(raw);
  const quoted = raw.match(/^"([^"]+)"/) || raw.match(/^'([^']+)'/);
  const token = quoted?.[1] || raw.split(/\s+/)[0];
  add(token);
  if (token) add(path.dirname(token));
  return out;
}

function queryWindowsRegistryStudioCandidates(env = process.env) {
  if (process.platform !== "win32") return [];
  try {
    const script = [
      "$paths = @(",
      "  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
      "  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
      "  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
      ")",
      "$out = @()",
      "foreach ($path in $paths) {",
      "  Get-ItemProperty -Path $path -ErrorAction SilentlyContinue |",
      "    Where-Object { $_.DisplayName -match 'Android Studio' } |",
      "    ForEach-Object { $out += [pscustomobject]@{ installLocation = $_.InstallLocation; displayIcon = $_.DisplayIcon; uninstallString = $_.UninstallString; displayName = $_.DisplayName } }",
      "}",
      "$out | ConvertTo-Json -Compress",
    ].join("\n");
    const stdout = execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-Command", script,
    ], {
      encoding: "utf8",
      env,
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout || "[]");
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return records.flatMap((item) => [
      String(item?.installLocation || "").trim(),
      ...commandPathCandidates(item?.displayIcon),
      ...commandPathCandidates(item?.uninstallString),
    ]).filter(Boolean);
  } catch {
    return [];
  }
}

function scanWindowsRegistry(add, env, options = {}) {
  const candidates = Array.isArray(options.registryCandidates)
    ? options.registryCandidates
    : queryWindowsRegistryStudioCandidates(env);
  for (const candidate of candidates) add(candidate, "Windows registry", "registry");
}

function scanLocalPrograms(localAppData, add) {
  const programs = path.join(localAppData, "Programs");
  for (const name of listDirs(programs)) {
    if (!/^Android Studio/i.test(name)) continue;
    add(path.join(programs, name, "bin", "studio64.exe"), `${name} (LocalAppData)`, "scan");
    add(path.join(programs, name, "bin", "studio.exe"), `${name} (LocalAppData)`, "scan");
  }
}

function scanToolboxForStudios(root, exeName) {
  const hits = [];
  for (const ch of listDirs(root)) {
    const chDir = path.join(root, ch);
    for (const build of listDirs(chDir)) {
      const exe = path.join(chDir, build, "bin", exeName);
      if (existsSync(exe)) hits.push(exe);
    }
  }
  return hits;
}

function scanToolboxApps(appsRoot, add) {
  for (const appName of listDirs(appsRoot)) {
    if (!/android[-_ ]?studio/i.test(appName)) continue;
    for (const exe of scanToolboxForStudios(path.join(appsRoot, appName), "studio64.exe")) {
      add(exe, "Toolbox", "toolbox");
    }
  }
}

function parseSortKey(studio) {
  const src = String(studio.build || studio.version || "").replace(/^AI-/i, "");
  return src.split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
}

function cmpVersionDesc(a, b) {
  const ka = parseSortKey(a);
  const kb = parseSortKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i += 1) {
    const d = (kb[i] || 0) - (ka[i] || 0);
    if (d) return d;
  }
  return (b.mtimeMs || 0) - (a.mtimeMs || 0);
}

function studioInfo(exe, dirName, source = "scan") {
  const root = /\.app$/i.test(exe) ? path.join(exe, "Contents", "Resources") : path.dirname(path.dirname(exe));
  let name = null;
  let version = null;
  let build = null;
  try {
    const pi = JSON.parse(readFileSync(path.join(root, "product-info.json"), "utf-8"));
    name = pi.name || null;
    build = pi.buildNumber || null;
    const dataVersion = String(pi.dataDirectoryName || "").replace(/^AndroidStudio/i, "").trim();
    version = dataVersion || pi.version || null;
  } catch {}
  const st = safeStat(exe);
  const label = (name || "Android Studio") + (version ? ` ${version}` : "");
  return {
    exe,
    dir: dirName,
    label,
    name: name || "Android Studio",
    version,
    build,
    source,
    mtimeMs: st?.mtimeMs || 0,
  };
}

export function listAndroidStudios(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const cfg = options.config || getConfig();
  const out = [];
  const seen = new Set();
  const add = (candidate, dirName = "Android Studio", source = "scan") => {
    const exe = resolveAndroidStudioExecutable(candidate, { platform, env });
    if (!exe) return;
    const key = platform === "win32" ? exe.toLowerCase() : exe;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(studioInfo(exe, dirName, source));
  };

  add(cfg?.devbench?.androidStudioPath, "configured", "config");
  add(env.ANDROID_STUDIO, "ANDROID_STUDIO", "environment");
  add(env.ANDROID_STUDIO_HOME, "ANDROID_STUDIO_HOME", "environment");
  add(env.STUDIO_HOME, "STUDIO_HOME", "environment");

  if (platform === "win32") {
    const driveLetters = options.winDriveLetters || "CDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    for (const letter of driveLetters) {
      const drive = `${letter}:\\`;
      if (!existsSync(drive)) continue;
      scanAndroidRoot(path.join(drive, "Program Files", "Android"), add);
      scanAndroidRoot(path.join(drive, "Program Files (x86)", "Android"), add);
    }

    const localAppData = env.LOCALAPPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Local") : "");
    if (localAppData) {
      scanLocalPrograms(localAppData, add);
      scanToolboxApps(path.join(localAppData, "JetBrains", "Toolbox", "apps"), add);
    }
    if (env.APPDATA) scanToolboxApps(path.join(env.APPDATA, "JetBrains", "Toolbox", "apps"), add);
    if (env.ProgramFiles) scanToolboxApps(path.join(env.ProgramFiles, "JetBrains", "Toolbox", "apps"), add);
    scanWindowsShortcuts(add, env, options);
    scanWindowsRegistry(add, env, options);
  } else if (platform === "darwin") {
    const appDirs = options.appDirs || ["/Applications", path.join(os.homedir(), "Applications")];
    for (const appDir of appDirs) {
      for (const name of listDirs(appDir)) {
        if (/^Android Studio.*\.app$/i.test(name)) add(path.join(appDir, name), path.basename(name, ".app"), "scan");
      }
    }
  } else {
    const linuxCandidates = options.linuxCandidates || [
      "/opt/android-studio/bin/studio.sh",
      "/usr/local/android-studio/bin/studio.sh",
      path.join(os.homedir(), "android-studio", "bin", "studio.sh"),
      "/snap/bin/android-studio",
    ];
    for (const candidate of linuxCandidates) add(candidate, "Android Studio", "scan");
  }

  out.sort(cmpVersionDesc);
  return out;
}

export function getAndroidStudioState(options = {}) {
  const studios = listAndroidStudios(options);
  return {
    studios,
    count: studios.length,
    defaultExe: studios[0]?.exe || null,
    detectedAt: new Date().toISOString(),
  };
}

export function refreshAndroidStudioState(options = {}) {
  const state = getAndroidStudioState(options);
  const cfg = getConfig();
  const currentPath = String(cfg?.devbench?.androidStudioPath || "").trim();
  const currentResolved = resolveAndroidStudioExecutable(currentPath, options);
  const nextPath = state.defaultExe || (currentResolved ? currentPath : "");
  const nextDevbench = {
    ...(cfg.devbench || {}),
    androidStudioPath: nextPath,
    androidStudioCount: state.count,
    androidStudioDetectedAt: state.detectedAt,
  };

  const needsPersist =
    (cfg.devbench?.androidStudioPath || "") !== nextDevbench.androidStudioPath ||
    Number(cfg.devbench?.androidStudioCount || 0) !== state.count;

  if (options.persist !== false && needsPersist) updateConfig({ devbench: nextDevbench });
  return { ...state, defaultExe: nextPath || null };
}

export function findAndroidStudio(options = {}) {
  return getAndroidStudioState(options).defaultExe;
}
