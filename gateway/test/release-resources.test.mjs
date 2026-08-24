import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findReleaseResourceViolations,
  prepareReleaseResources,
} from "../services/release-resources.js";

test("release resources exclude private keys and replace local project config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-resources-"));
  const output = path.join(root, "output");
  try {
    fs.mkdirSync(path.join(root, "skills", "demo", "keys"), { recursive: true });
    fs.mkdirSync(path.join(root, "skills", "demo", "__tests__"), { recursive: true });
    fs.mkdirSync(path.join(root, "configs"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "demo", "safe.js"), "console.log('safe');\n");
    fs.writeFileSync(
      path.join(root, "skills", "demo", "keys", "private.pem"),
      "<REDACTED_PRIVATE_KEY>\n",
    );
    fs.writeFileSync(path.join(root, "skills", "demo", "keys", "opaque.jar"), "opaque archive");
    fs.writeFileSync(path.join(root, "skills", "demo", "__tests__", "fixture.js"), "test fixture");
    fs.writeFileSync(path.join(root, "configs", "device-profiles.json"), "{\"devices\":[]}\n");
    fs.writeFileSync(path.join(root, "configs", "market-projects.json"), JSON.stringify({
      projects: [{ id: "local", path: "C:\\Users\\person\\project" }],
      dingtalkMsgConfig: { publish: { signed: [{ mobile: "13800138000" }] } },
    }));

    const result = prepareReleaseResources(root, output);
    assert.ok(result.skipped.some((entry) => entry.path.endsWith("private.pem")));
    assert.ok(result.skipped.some((entry) => entry.path.endsWith("opaque.jar")));
    assert.ok(result.skipped.some((entry) => entry.path.endsWith("__tests__")));
    assert.equal(fs.existsSync(path.join(output, "skills", "demo", "safe.js")), true);
    assert.equal(fs.existsSync(path.join(output, "skills", "demo", "keys", "private.pem")), false);
    assert.equal(fs.existsSync(path.join(output, "skills", "demo", "keys", "opaque.jar")), false);
    assert.equal(fs.existsSync(path.join(output, "skills", "demo", "__tests__")), false);

    const marketText = fs.readFileSync(path.join(output, "configs", "market-projects.json"), "utf8");
    const market = JSON.parse(marketText);
    assert.deepEqual(market.projects, []);
    assert.equal(Object.hasOwn(market, "dingtalkMsgConfig"), false);
    assert.doesNotMatch(marketText, /recipient|mobile|[A-Z]:[\\/]/i);
    assert.deepEqual(findReleaseResourceViolations(output), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("release verification detects a private key added after preparation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-verify-"));
  try {
    fs.mkdirSync(path.join(root, "skills"), { recursive: true });
    fs.mkdirSync(path.join(root, "configs"), { recursive: true });
    fs.writeFileSync(path.join(root, "configs", "device-profiles.json"), "{\"devices\":[]}\n");
    fs.writeFileSync(path.join(root, "configs", "market-projects.json"), "{\"projects\":[]}\n");
    fs.writeFileSync(path.join(root, "skills", "hidden.txt"), "<REDACTED_PRIVATE_KEY_MARKER>\n");

    assert.ok(findReleaseResourceViolations(root).some((entry) => entry.includes("sensitive file")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
