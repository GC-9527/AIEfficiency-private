"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  assertPinnedNodeRuntime,
  normalizeNodeVersion,
} = require("./runtime-policy.cjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createPolicyFixture(expectedVersion = "24.14.1") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-runtime-policy-"));
  fs.writeFileSync(path.join(root, ".node-version"), `${expectedVersion}\n`, "utf8");
  for (const project of ["desktop", "gateway"]) {
    writeJson(path.join(root, project, "package.json"), {
      engines: { node: expectedVersion },
    });
    writeJson(path.join(root, project, "package-lock.json"), {
      packages: { "": { engines: { node: expectedVersion } } },
    });
  }
  return root;
}

test("Node version normalization accepts process-style v prefixes", () => {
  assert.equal(normalizeNodeVersion("v24.14.1\n"), "24.14.1");
});

test("runtime policy accepts one exact version across build and package metadata", () => {
  const root = createPolicyFixture();
  try {
    const result = assertPinnedNodeRuntime({
      repoRoot: root,
      actualNodeVersion: "v24.14.1",
    });
    assert.equal(result.expectedVersion, "24.14.1");
    assert.equal(result.actualVersion, "24.14.1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime policy rejects a different build Node before packaging", () => {
  const root = createPolicyFixture();
  try {
    assert.throws(
      () => assertPinnedNodeRuntime({
        repoRoot: root,
        actualNodeVersion: "v22.0.0",
      }),
      /build Node is 22\.0\.0, expected 24\.14\.1/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime policy rejects package or lock metadata that drifts from .node-version", () => {
  const root = createPolicyFixture();
  try {
    writeJson(path.join(root, "gateway", "package-lock.json"), {
      packages: { "": { engines: { node: "22.0.0" } } },
    });
    assert.throws(
      () => assertPinnedNodeRuntime({
        repoRoot: root,
        actualNodeVersion: "24.14.1",
      }),
      /gateway\/package-lock\.json root engines\.node is 22\.0\.0/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repository runtime policy matches the Node executing Desktop preflight", () => {
  assert.doesNotThrow(() => assertPinnedNodeRuntime());
});
