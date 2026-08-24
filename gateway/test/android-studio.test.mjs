import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "android-studio-detect-"));
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  devbench: {
    androidStudioPath: path.join(tmp, "removed", "bin", "studio64.exe"),
    androidStudioCount: 99,
  },
}));

const mod = await import("../services/android-studio.js");

function fakeStudio(root, build, dataDirectoryName = "AndroidStudio2024.3") {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const exe = path.join(bin, "studio64.exe");
  fs.writeFileSync(exe, "");
  fs.writeFileSync(path.join(root, "product-info.json"), JSON.stringify({
    name: "Android Studio",
    buildNumber: build,
    dataDirectoryName,
  }));
  return exe;
}

test("refresh updates stale configured path and stores detected count", () => {
  const localAppData = path.join(tmp, "localappdata-refresh");
  const older = fakeStudio(path.join(localAppData, "Programs", "Android Studio 2024.2"), "242.100.1", "AndroidStudio2024.2");
  const newer = fakeStudio(path.join(localAppData, "Programs", "Android Studio 2024.3"), "243.200.1", "AndroidStudio2024.3");

  const state = mod.refreshAndroidStudioState({
    platform: "win32",
    env: { LOCALAPPDATA: localAppData },
    winDriveLetters: [],
    shortcutTargets: [],
    registryCandidates: [],
  });

  assert.equal(state.count, 2);
  assert.equal(state.defaultExe, newer);
  assert.deepEqual(state.studios.map((s) => s.exe), [newer, older]);

  const saved = JSON.parse(fs.readFileSync(process.env.GATEWAY_CONFIG_PATH, "utf-8"));
  assert.equal(saved.devbench.androidStudioPath, newer);
  assert.equal(saved.devbench.androidStudioCount, 2);
  assert.match(saved.devbench.androidStudioDetectedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("resolve accepts install directory and prefers studio64 next to studio.exe", () => {
  const root = path.join(tmp, "manual-install", "Android Studio");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const studio32 = path.join(bin, "studio.exe");
  const studio64 = path.join(bin, "studio64.exe");
  fs.writeFileSync(studio32, "");
  fs.writeFileSync(studio64, "");

  assert.equal(mod.resolveAndroidStudioExecutable(root, { platform: "win32" }), studio64);
  assert.equal(mod.resolveAndroidStudioExecutable(studio32, { platform: "win32" }), studio64);
});

test("toolbox scan counts multiple Android Studio builds", () => {
  const localAppData = path.join(tmp, "localappdata-toolbox");
  const oldToolbox = fakeStudio(path.join(localAppData, "JetBrains", "Toolbox", "apps", "AndroidStudio", "ch-0", "242.100"), "242.100.1", "AndroidStudio2024.2");
  const newToolbox = fakeStudio(path.join(localAppData, "JetBrains", "Toolbox", "apps", "AndroidStudio", "ch-0", "243.200"), "243.200.1", "AndroidStudio2024.3");

  const list = mod.listAndroidStudios({
    platform: "win32",
    env: { LOCALAPPDATA: localAppData },
    winDriveLetters: [],
    config: { devbench: {} },
    shortcutTargets: [],
    registryCandidates: [],
  });

  assert.equal(list.length, 2);
  assert.deepEqual(list.map((s) => s.exe), [newToolbox, oldToolbox]);
});

test("windows shortcut target can replace stale configured install", () => {
  const configuredRoot = path.join(tmp, "old-program-files", "Android Studio");
  const shortcutRoot = path.join(tmp, "develop", "Android Studio");
  const configuredExe = fakeStudio(configuredRoot, "242.100.1", "AndroidStudio2024.2");
  const shortcutExe = fakeStudio(shortcutRoot, "252.200.1", "AndroidStudio2025.2");

  const state = mod.getAndroidStudioState({
    platform: "win32",
    env: {},
    winDriveLetters: [],
    config: { devbench: { androidStudioPath: configuredExe } },
    shortcutTargets: [shortcutExe],
    registryCandidates: [],
  });

  assert.equal(state.count, 2);
  assert.equal(state.defaultExe, shortcutExe);
  assert.deepEqual(state.studios.map((s) => s.exe), [shortcutExe, configuredExe]);
});

test("windows registry install location supports custom machine paths", () => {
  const customRoot = path.join(tmp, "custom-drive", "Tools", "Android Studio");
  const customExe = fakeStudio(customRoot, "263.10.1", "AndroidStudio2026.3");
  const uninstallExe = path.join(customRoot, "uninstall.exe");
  fs.writeFileSync(uninstallExe, "");

  const state = mod.getAndroidStudioState({
    platform: "win32",
    env: {},
    winDriveLetters: [],
    config: { devbench: {} },
    shortcutTargets: [],
    registryCandidates: [uninstallExe],
  });

  assert.equal(state.count, 1);
  assert.equal(state.defaultExe, customExe);
  assert.equal(state.studios[0].source, "registry");
  assert.notEqual(state.defaultExe, uninstallExe);
});
