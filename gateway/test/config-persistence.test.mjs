import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const gatewayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configModuleUrl = pathToFileURL(path.join(gatewayRoot, "services", "config.js")).href;

function isolatedEnv(configPath, extra = {}) {
  const env = { ...process.env, GATEWAY_CONFIG_PATH: configPath, ...extra };
  delete env.FEISHU_PROJECT_MCP_TOKEN;
  delete env.MCP_USER_TOKEN;
  return env;
}

function runModuleScript(script, env) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: gatewayRoot,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return JSON.parse(line || "{}");
}

test("config credentials survive a second process without credential environment variables", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-config-persist-"));
  const configPath = path.join(root, "gateway.json");
  const token = "persistence-sentinel-5af05da4";
  fs.writeFileSync(configPath, "{}", "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const writer = runModuleScript(`
    const { updateConfig } = await import(${JSON.stringify(configModuleUrl)});
    const token = process.env.PERSISTENCE_TEST_TOKEN;
    updateConfig({
      feishuProjectSync: {
        feishu: {
          authMode: "mcp",
          mcp: {
            enabled: true,
            transport: "http-header",
            serverUrl: "https://mcp.invalid/v1",
            headerName: "X-Mcp-Token",
            token,
          },
        },
      },
    });
    process.stdout.write(JSON.stringify({ saved: true, tokenLength: token.length }));
  `, isolatedEnv(configPath, { PERSISTENCE_TEST_TOKEN: token }));
  assert.deepEqual(writer, { saved: true, tokenLength: token.length });

  const reader = runModuleScript(`
    const { createHash } = await import("node:crypto");
    const { getConfig } = await import(${JSON.stringify(configModuleUrl)});
    const token = String(getConfig()?.feishuProjectSync?.feishu?.mcp?.token || "");
    process.stdout.write(JSON.stringify({
      configured: token.length > 0,
      tokenLength: token.length,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      envCredentialPresent: !!(process.env.FEISHU_PROJECT_MCP_TOKEN || process.env.MCP_USER_TOKEN),
    }));
  `, isolatedEnv(configPath));

  assert.equal(reader.configured, true);
  assert.equal(reader.tokenLength, token.length);
  assert.equal(reader.tokenHash, createHash("sha256").update(token).digest("hex"));
  assert.equal(reader.envCredentialPresent, false);
});

test("failed config persistence throws and does not publish the update in memory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-config-failure-"));
  const configPath = path.join(root, "config-target-is-a-directory");
  fs.mkdirSync(configPath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = runModuleScript(`
    const { getConfig, updateConfig } = await import(${JSON.stringify(configModuleUrl)});
    let error = null;
    try {
      updateConfig({ persistenceFailureMarker: "must-not-publish" });
    } catch (caught) {
      error = caught;
    }
    process.stdout.write(JSON.stringify({
      threw: !!error,
      code: error?.code || "",
      markerPublished: getConfig().persistenceFailureMarker === "must-not-publish",
    }));
  `, isolatedEnv(configPath));

  assert.equal(result.threw, true);
  assert.equal(result.markerPublished, false);
  assert.ok(result.code);
});
