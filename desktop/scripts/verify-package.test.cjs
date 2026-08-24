"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  verifyPackageConfig,
  verifyPackagedEntries,
} = require("./verify-package.cjs");

function writeFixtureFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function createFixture(buildFiles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-package-verify-"));
  writeFixtureFile(root, "package.json", `${JSON.stringify({
    main: "main.js",
    build: { files: buildFiles },
  }, null, 2)}\n`);
  writeFixtureFile(root, "main.js", 'require("./cardev-ipc.js");\n');
  writeFixtureFile(root, "cardev-ipc.js", 'require("./external-url.js");\n');
  writeFixtureFile(root, "external-url.js", "module.exports = {};\n");
  return root;
}

test("package verification fails before build when a transitive local module is omitted", () => {
  const root = createFixture(["main.js", "cardev-ipc.js"]);
  try {
    assert.throws(
      () => verifyPackageConfig(root),
      /cardev-ipc\.js.*not matched by build\.files: external-url\.js/s,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("package verification follows the local module graph and accepts declared modules", () => {
  const root = createFixture(["*.js"]);
  try {
    const verification = verifyPackageConfig(root);
    assert.deepEqual(
      verification.requiredFiles,
      ["cardev-ipc.js", "external-url.js", "main.js"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("post-pack verification rejects an app.asar that omitted a required module", () => {
  const root = createFixture(["*.js"]);
  try {
    const verification = verifyPackageConfig(root);
    assert.throws(
      () => verifyPackagedEntries(verification, ["main.js", "cardev-ipc.js"]),
      /app\.asar is missing required Desktop runtime module\(s\): external-url\.js/,
    );
    assert.doesNotThrow(() =>
      verifyPackagedEntries(
        verification,
        ["main.js", "cardev-ipc.js", "external-url.js"],
      ));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Desktop build entry points keep both pre-pack and post-pack verification enabled", () => {
  const desktopRoot = path.resolve(__dirname, "..");
  const packageConfig = JSON.parse(
    fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
  );
  const rootBuildScript = fs.readFileSync(
    path.join(desktopRoot, "..", "scripts", "build.ps1"),
    "utf8",
  );

  assert.ok(packageConfig.build.files.includes("external-url.js"));
  assert.ok(packageConfig.build.files.includes("gateway-runtime.cjs"));
  assert.ok(packageConfig.build.files.includes("gateway-dependency-manager.cjs"));
  assert.equal(packageConfig.build.beforePack, "scripts/before-pack.cjs");
  assert.equal(packageConfig.build.afterPack, "scripts/after-pack.cjs");
  assert.match(packageConfig.scripts["prepare-resources"], /^npm run preflight && /);
  assert.match(packageConfig.scripts.preflight, /scripts\/preflight\.cjs && npm test/);
  assert.match(rootBuildScript, /Run Desktop release preflight/);
  assert.match(rootBuildScript, /\$Target -eq "all" -or \$Target -eq "desktop"/);
  assert.doesNotThrow(() => verifyPackageConfig(desktopRoot));
});
