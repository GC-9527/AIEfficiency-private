import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  APPMARKET_MCP_ENV_NAMES,
  APPMARKET_MCP_REGISTRATION_ID,
  APPMARKET_MCP_TOOL_NAMES,
  callAppMarketMcpTool,
  closeAppMarketMcpBridge,
  ensureGeminiAppMarketMcpRegistration,
  getAppMarketMcpOpenAiTools,
  inspectAppMarketMcpRuntime,
  mergeAppMarketMcpIntoCodexToml,
  prepareStoryAppMarketMcpForCli,
  resolveAppMarketMcpRegistration,
} from "../services/appmarket-admin-mcp.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test("AppMarket MCP runtime resolves a trusted absolute repository package", () => {
  const inspected = inspectAppMarketMcpRuntime();
  assert.equal(inspected.ok, true, inspected.problems.join("; "));
  assert.equal(path.isAbsolute(inspected.registration.command), true);
  assert.equal(path.isAbsolute(inspected.registration.args[0]), true);
  assert.equal(path.isAbsolute(inspected.registration.cwd), true);
  assert.equal(inspected.registration.id, APPMARKET_MCP_REGISTRATION_ID);
  assert.deepEqual(inspected.registration.envVars, APPMARKET_MCP_ENV_NAMES);
  assert.deepEqual(inspected.registration.enabledTools, APPMARKET_MCP_TOOL_NAMES);
});

test("Codex session config merge is idempotent and preserves unrelated settings", () => {
  const existing = [
    'model = "gpt-test"',
    "",
    "[mcp_servers.other]",
    'command = "other-command"',
    "",
    `[mcp_servers.${APPMARKET_MCP_REGISTRATION_ID}]`,
    'command = "stale-relative-command"',
    "",
  ].join("\n");
  const merged = mergeAppMarketMcpIntoCodexToml(existing);
  assert.match(merged, /model = "gpt-test"/);
  assert.match(merged, /\[mcp_servers\.other\]/);
  assert.equal((merged.match(/\[mcp_servers\.appmarket_admin_backend\]/g) || []).length, 1);
  assert.equal(merged.includes("stale-relative-command"), false);
  assert.match(merged, /env_vars = \[/);
  assert.equal(merged.includes("APPMARKET_ADMIN_PASSWORD="), false);
  assert.equal(mergeAppMarketMcpIntoCodexToml(merged), merged);
});

test("all native story CLI engines receive the same MCP registration before spawn", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "appmarket-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
  fs.writeFileSync(path.join(home, ".gemini", "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");

  for (const engine of ["claude", "claude-volcengine", "claude-minimax", "claude-atlas"]) {
    const runtime = prepareStoryAppMarketMcpForCli(engine, { args: ["-p"], env: {}, home });
    assert.equal(runtime.supported, true);
    const flagIndex = runtime.args.indexOf("--mcp-config");
    assert.notEqual(flagIndex, -1);
    const config = JSON.parse(fs.readFileSync(runtime.args[flagIndex + 1], "utf8"));
    assert.equal(path.isAbsolute(config.mcpServers[APPMARKET_MCP_REGISTRATION_ID].command), true);
    assert.equal(path.isAbsolute(config.mcpServers[APPMARKET_MCP_REGISTRATION_ID].args[0]), true);
    runtime.cleanup();
    assert.equal(fs.existsSync(runtime.args[flagIndex + 1]), false);
  }

  const gemini = prepareStoryAppMarketMcpForCli("gemini", { args: ["--yolo"], env: {}, home });
  assert.equal(gemini.supported, true);
  assert.deepEqual(gemini.args.slice(-3), ["--skip-trust", "--allowed-mcp-server-names", APPMARKET_MCP_REGISTRATION_ID]);
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "settings.json"), "utf8"));
  assert.equal(settings.theme, "dark");
  assert.equal(settings.mcpServers[APPMARKET_MCP_REGISTRATION_ID].trust, true);
  assert.deepEqual(settings.mcpServers[APPMARKET_MCP_REGISTRATION_ID].includeTools, APPMARKET_MCP_TOOL_NAMES);

  for (const engine of ["codex", "codex-minimax", "codex-atlas"]) {
    const runtime = prepareStoryAppMarketMcpForCli(engine, { args: ["exec", "--json", "-"], env: {}, home });
    assert.equal(runtime.supported, true);
    assert.equal(runtime.args.at(-1), "-");
    assert.equal(runtime.args.some((arg) => arg.startsWith("mcp_servers.appmarket_admin_backend.command=")), true);
    assert.equal(runtime.args.some((arg) => arg.startsWith("mcp_servers.appmarket_admin_backend.enabled_tools=")), true);
  }
});

test("Gemini registration is idempotent and never serializes AppMarket credential values", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "appmarket-gemini-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const first = ensureGeminiAppMarketMcpRegistration({ home });
  const second = ensureGeminiAppMarketMcpRegistration({ home });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  const text = fs.readFileSync(first.settingsPath, "utf8");
  for (const name of APPMARKET_MCP_ENV_NAMES) assert.equal(text.includes(`${name}=`), false);
});

test("API and Agent V2 bridge discovers and calls all 20 read-only MCP tools", async (t) => {
  t.after(() => closeAppMarketMcpBridge());
  const tools = await getAppMarketMcpOpenAiTools();
  assert.deepEqual(tools.map((tool) => tool.function.name), APPMARKET_MCP_TOOL_NAMES);
  for (const tool of tools) {
    assert.equal(tool.type, "function");
    assert.equal(tool.function.parameters.type, "object");
    assert.match(tool.function.description, /只读/);
  }
  const raw = await callAppMarketMcpTool("appmarket_admin_capabilities", {});
  const payload = JSON.parse(raw);
  assert.equal(payload.status, "ok");
  assert.equal(payload.data.service, "appmarket-admin-readonly");
  assert.equal(payload.data.transport, "stdio");
  assert.deepEqual(payload.data.tools, APPMARKET_MCP_TOOL_NAMES);
});

test("registration object exposes no literal credentials", () => {
  const text = JSON.stringify(resolveAppMarketMcpRegistration());
  assert.equal(/password\s*[:=]\s*[^"\]]/i.test(text), false);
  assert.equal(text.includes("Bearer "), false);
});

test("startup, acceptance, and release paths guard the MCP runtime dependencies", () => {
  const gatewayPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "gateway", "package.json"), "utf8"));
  assert.equal(gatewayPackage.dependencies["@modelcontextprotocol/sdk"], "1.29.0");
  assert.equal(gatewayPackage.dependencies.zod, "3.25.76");

  const startPowerShell = fs.readFileSync(path.join(repoRoot, "start.ps1"), "utf8");
  const startShell = fs.readFileSync(path.join(repoRoot, "start.sh"), "utf8");
  const buildPowerShell = fs.readFileSync(path.join(repoRoot, "scripts", "build.ps1"), "utf8");
  const bundleSource = fs.readFileSync(path.join(repoRoot, "gateway", "services", "bundle.js"), "utf8");
  const acceptanceSource = fs.readFileSync(path.join(repoRoot, "scripts", "acceptance.mjs"), "utf8");
  const desktopBundleSource = fs.readFileSync(path.join(repoRoot, "desktop", "scripts", "gateway-bundle.cjs"), "utf8");
  const serviceControlBundleSource = fs.readFileSync(path.join(repoRoot, "service-control-electron", "scripts", "prepare-gateway.js"), "utf8");

  for (const source of [startPowerShell, startShell]) {
    assert.match(source, /@modelcontextprotocol[\\/]sdk[\\/]package\.json/);
    assert.match(source, /zod[\\/]package\.json/);
  }
  assert.match(buildPowerShell, /mcp-servers[\\/]devServer/);
  assert.match(bundleSource, /mcp-servers["', ]+devServer/);
  assert.match(desktopBundleSource, /mcp-servers["', ]+devServer/);
  assert.match(serviceControlBundleSource, /mcp-servers["', ]+devServer/);
  assert.match(acceptanceSource, /AppMarket MCP stdio smoke/);
});
