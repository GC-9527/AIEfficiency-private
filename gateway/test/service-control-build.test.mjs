import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..");
const require = createRequire(import.meta.url);
const {
  BUILD_TARGETS,
  defaultBuildTargets,
  normalizeBuildTargets,
  validateBuildTargets,
} = require(path.join(repoRoot, "service-control-electron", "build-policy.cjs"));

test("build targets default to web only and preserve the canonical execution order", () => {
  assert.deepEqual(defaultBuildTargets(), ["web"]);
  assert.equal(BUILD_TARGETS.find((target) => target.id === "web")?.defaultSelected, true);
  assert.equal(BUILD_TARGETS.find((target) => target.id === "desktop")?.defaultSelected, false);
  assert.deepEqual(
    normalizeBuildTargets(["cloud", "web", "desktop", "web"]),
    ["web", "desktop", "cloud"],
  );
});

test("build target validation rejects empty and unknown selections", () => {
  assert.throws(() => validateBuildTargets([]), /至少选择一个/);
  assert.throws(() => validateBuildTargets(["web", "unknown"]), /不支持的编译目标/);
  assert.deepEqual(validateBuildTargets(["desktop", "web"]), ["web", "desktop"]);
});

test("Service Control exposes build IPC and packages its policy module", () => {
  const main = fs.readFileSync(path.join(repoRoot, "service-control-electron", "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(repoRoot, "service-control-electron", "preload.js"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "service-control-electron", "package.json"),
    "utf8",
  ));

  assert.match(main, /ipcMain\.handle\("build:start"/);
  assert.match(main, /scripts", "build\.ps1"/);
  assert.match(main, /"-NoOpen"/);
  assert.match(main, /mainWindow\.webContents\.send\("build:progress"/);
  assert.match(main, /enabled: !hasActiveBuild\(\)/);
  assert.match(preload, /startBuild: \(profileId, targets\)/);
  assert.match(preload, /onBuildProgress:/);
  assert.ok(packageJson.build.files.includes("build-policy.cjs"));
});

test("build dialog defaults to web selected and desktop unselected", () => {
  const html = fs.readFileSync(
    path.join(repoRoot, "service-control-electron", "renderer", "index.html"),
    "utf8",
  );
  const renderer = fs.readFileSync(
    path.join(repoRoot, "service-control-electron", "renderer", "renderer.js"),
    "utf8",
  );

  const webInput = html.match(/<input[^>]+data-build-target="web"[^>]*>/)?.[0] || "";
  const desktopInput = html.match(/<input[^>]+data-build-target="desktop"[^>]*>/)?.[0] || "";
  assert.match(webInput, /\schecked\b/);
  assert.doesNotMatch(desktopInput, /\schecked\b/);
  assert.match(renderer, /selectedBuildTargets\(\)/);
  assert.match(renderer, /window\.serviceControl\.startBuild\(buildModalProfileId, targets\)/);
  assert.match(renderer, /\$\("buildCloseIcon"\)\.disabled = false/);
  assert.match(renderer, /\$\("buildCloseBtn"\)\.disabled = false/);
});

test("generated development panel URLs use the same-origin proxy without a rejected gateway query", () => {
  const main = fs.readFileSync(path.join(repoRoot, "service-control-electron", "main.js"), "utf8");
  assert.match(main, /function webPanelUrl\(webPort\)/);
  assert.match(main, /VITE_GATEWAY_URL: `http:\/\/127\.0\.0\.1:\$\{gatewayPort\}`/);
  assert.doesNotMatch(main, /\/\?gateway=http:\/\/127\.0\.0\.1/);
});
