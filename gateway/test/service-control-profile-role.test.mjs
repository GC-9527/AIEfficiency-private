import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import profileRolePolicy from "../../service-control-electron/profile-role-policy.cjs";
import instanceIdentity from "../../service-control-electron/instance-identity.cjs";

const {
  applyStartupRepoRoles,
  configuredDevelopmentIds,
  nextDevelopmentProfileId,
} = profileRolePolicy;
const { sourceInstanceKey, sourceUserDataPath } = instanceIdentity;

const CURRENT = "D:\\workspace\\xsProjects\\202606\\AIEfficiency202606";
const TRACK = "D:\\workspace\\xsProjects\\202606\\AIEfficiencyTrack";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("a Development startup hint does not duplicate or clear the same persisted Production repository", () => {
  const profiles = applyStartupRepoRoles({
    production: {
      repoRoot: CURRENT,
      gatewayPort: 3001,
      webPort: 3000,
      label: "My Production",
    },
    development: { repoRoot: TRACK, gatewayPort: 3101, webPort: 3100 },
    "development-2": { repoRoot: CURRENT, gatewayPort: 3201, webPort: 3200 },
  }, {
    sourceRoot: CURRENT,
    explicitDevelopmentRoots: [CURRENT],
  });

  assert.deepEqual(profiles.production, {
    repoRoot: CURRENT,
    gatewayPort: 3001,
    webPort: 3000,
    label: "My Production",
  });
  assert.deepEqual(configuredDevelopmentIds(profiles), ["development"]);
  assert.equal(profiles.development.repoRoot, TRACK);
  assert.equal(profiles["development-2"], undefined);
});

test("a Development startup hint adds a non-conflicting repository without changing persisted Production", () => {
  const profiles = applyStartupRepoRoles({
    production: { repoRoot: TRACK, gatewayPort: 3001, webPort: 3000 },
  }, {
    sourceRoot: CURRENT,
    explicitDevelopmentRoots: [CURRENT],
  });

  assert.equal(profiles.production.repoRoot, TRACK);
  assert.deepEqual(configuredDevelopmentIds(profiles), ["development"]);
  assert.equal(profiles.development.repoRoot, CURRENT);
});

test("a first-launch Development hint does not hard-code the source repository as Production", () => {
  const profiles = applyStartupRepoRoles({ production: {} }, {
    sourceRoot: CURRENT,
    explicitDevelopmentRoots: [CURRENT],
  });

  assert.equal(profiles.production.repoRoot, undefined);
  assert.deepEqual(configuredDevelopmentIds(profiles), ["development"]);
  assert.equal(profiles.development.repoRoot, CURRENT);
});

test("the source fallback respects persisted Production and otherwise creates a Development tab", () => {
  const productionProfiles = applyStartupRepoRoles({
    production: { repoRoot: CURRENT },
  }, {
    sourceRoot: CURRENT,
  });
  assert.equal(productionProfiles.production.repoRoot, CURRENT);
  assert.deepEqual(configuredDevelopmentIds(productionProfiles), []);

  const blankProfiles = applyStartupRepoRoles({ production: {} }, {
    sourceRoot: CURRENT,
  });
  assert.equal(blankProfiles.production.repoRoot, undefined);
  assert.deepEqual(configuredDevelopmentIds(blankProfiles), ["development"]);
  assert.equal(blankProfiles.development.repoRoot, CURRENT);
});

test("a Production startup hint cannot overwrite persisted Production", () => {
  const profiles = applyStartupRepoRoles({
    production: { repoRoot: TRACK },
    development: { repoRoot: CURRENT },
    "development-2": { repoRoot: "D:\\workspace\\xsProjects\\202604\\AIEfficiency" },
  }, {
    sourceRoot: CURRENT,
    explicitProductionRoot: CURRENT,
  });

  assert.equal(profiles.production.repoRoot, TRACK);
  assert.deepEqual(configuredDevelopmentIds(profiles), ["development", "development-2"]);
  assert.equal(profiles.development.repoRoot, CURRENT);
});

test("a Production startup hint seeds only an empty Production and removes its legacy duplicate tab", () => {
  const profiles = applyStartupRepoRoles({
    production: {},
    development: { repoRoot: CURRENT },
    "development-2": { repoRoot: TRACK },
  }, {
    sourceRoot: CURRENT,
    explicitProductionRoot: CURRENT,
  });

  assert.equal(profiles.production.repoRoot, CURRENT);
  assert.deepEqual(configuredDevelopmentIds(profiles), ["development-2"]);
});

test("a removed primary Development tab stays removed and its id can be reused", () => {
  const profiles = {
    production: { repoRoot: CURRENT },
    "development-2": { repoRoot: TRACK },
  };
  assert.deepEqual(configuredDevelopmentIds(profiles), ["development-2"]);
  assert.equal(nextDevelopmentProfileId(profiles), "development");
});

test("desktop installers use a Development hint while role and runtime modules are packaged", () => {
  const installer = fs.readFileSync(path.join(REPO_ROOT, "scripts", "install-service-control.mjs"), "utf8");
  const packageConfig = JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, "service-control-electron", "package.json"),
    "utf8",
  ));

  assert.match(installer, /npm start -- --dev-repo/);
  assert.doesNotMatch(installer, /npm start -- --repo/);
  assert.ok(packageConfig.build.files.includes("profile-role-policy.cjs"));
  assert.ok(packageConfig.build.files.includes("api-engine-sync-runtime.cjs"));
});

test("source Service Control instances isolate their Electron user-data directory by checkout", () => {
  const main = fs.readFileSync(path.join(REPO_ROOT, "service-control-electron", "main.js"), "utf8");
  const packageConfig = JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, "service-control-electron", "package.json"),
    "utf8",
  ));

  const currentPath = "C:\\workspace\\AIEfficiency";
  const otherPath = "C:\\workspace\\GloriousRoadLite\\AIAutoDev";
  assert.equal(sourceInstanceKey(currentPath, "win32"), sourceInstanceKey(currentPath.toUpperCase(), "win32"));
  assert.notEqual(sourceInstanceKey(currentPath, "win32"), sourceInstanceKey(otherPath, "win32"));
  assert.notEqual(
    sourceUserDataPath("C:\\Users\\tester\\AppData\\Roaming", currentPath, "win32"),
    sourceUserDataPath("C:\\Users\\tester\\AppData\\Roaming", otherPath, "win32"),
  );
  assert.match(main, /function configureSourceUserDataPath\(\)/);
  assert.match(main, /if \(app\.isPackaged\) return;/);
  assert.match(main, /sourceUserDataPath\(app\.getPath\("appData"\), sourceRoot\)/);
  assert.match(main, /configureSourceUserDataPath\(\);[\s\S]*app\.requestSingleInstanceLock\(\)/);
  assert.ok(packageConfig.build.files.includes("instance-identity.cjs"));
});
