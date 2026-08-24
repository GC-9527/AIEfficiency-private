import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const {
  normalizeDeploymentRole,
  resolveConnectionDeploymentRole,
  applyDeploymentRoleToGatewayConfig,
  applyClientToStandaloneConfig,
} = require("../../desktop/deployment-role.js");

const roleOptions = [
  ["standalone", "全功能（本机开发 + 可提供中心服务，推荐）"],
  ["server", "仅服务端（可提供中心服务，无本机开发页面）"],
  ["node", "仅客户端（本机开发，不提供中心服务）"],
];

test("Desktop deployment roles use the same exact values as Gateway settings", () => {
  assert.equal(normalizeDeploymentRole("standalone"), "standalone");
  assert.equal(normalizeDeploymentRole("server"), "server");
  assert.equal(normalizeDeploymentRole("node"), "node");
  assert.equal(normalizeDeploymentRole("client"), "");
  assert.equal(normalizeDeploymentRole("unknown"), "");
});

test("legacy Desktop role selections retain their original meaning during migration", () => {
  assert.deepEqual(
    resolveConnectionDeploymentRole({ role: "server" }),
    { role: "standalone", legacy: true },
  );
  assert.deepEqual(
    resolveConnectionDeploymentRole({ role: "client" }),
    { role: "node", legacy: true },
  );
  assert.deepEqual(
    resolveConnectionDeploymentRole({ role: "client", deploymentRole: "server" }),
    { role: "server", legacy: false },
  );
});

test("switching a pure client to standalone clears the forced remote AI client", () => {
  const next = applyDeploymentRoleToGatewayConfig({
    role: "node",
    claudeProxy: { enabled: false, token: "local-token" },
    claudeProxyClient: { enabled: true, host: "http://server:3001" },
  }, "standalone");

  assert.equal(next.role, "standalone");
  assert.equal(next.claudeProxy.enabled, false);
  assert.equal(next.claudeProxy.token, "local-token");
  assert.equal(next.claudeProxyClient.enabled, false);
  assert.equal(next.claudeProxyClient.host, "http://server:3001");
});

test("non-admin Desktop upgrade only permits node to standalone and keeps sharing disabled", () => {
  const next = applyClientToStandaloneConfig({
    role: "node",
    claudeProxy: { enabled: false, token: "keep-local-settings" },
    claudeProxyClient: { enabled: true, host: "http://server:3001" },
  });

  assert.equal(next.role, "standalone");
  assert.equal(next.claudeProxy.enabled, false);
  assert.equal(next.claudeProxy.token, "keep-local-settings");
  assert.equal(next.claudeProxyClient.enabled, false);
  assert.throws(
    () => applyClientToStandaloneConfig({ role: "standalone" }),
    /仅允许从“仅客户端”切换到“全功能”/,
  );
  assert.throws(
    () => applyClientToStandaloneConfig({ role: "server" }),
    /仅允许从“仅客户端”切换到“全功能”/,
  );
});

test("server and client deployment roles enforce their matching AI direction", () => {
  const server = applyDeploymentRoleToGatewayConfig({}, "server");
  assert.equal(server.role, "server");
  assert.equal(server.claudeProxy.enabled, true);
  assert.equal(server.claudeProxyClient.enabled, false);

  const client = applyDeploymentRoleToGatewayConfig({}, "node");
  assert.equal(client.role, "node");
  assert.equal(client.claudeProxy.enabled, false);
  assert.equal(client.claudeProxyClient.enabled, true);
});

test("first-run selector and Settings show the same deployment role options", () => {
  const selector = fs.readFileSync(path.join(repoRoot, "desktop", "mode-select.html"), "utf8");
  const settings = fs.readFileSync(path.join(repoRoot, "web-dashboard", "src", "pages", "Settings.jsx"), "utf8");
  for (const [value, label] of roleOptions) {
    assert.ok(selector.includes(`<option value="${value}">${label}</option>`), `首次选择页缺少 ${label}`);
    assert.ok(settings.includes(`{ value: "${value}", label: "${label}" }`), `设置页缺少 ${label}`);
  }
  assert.equal(selector.includes("selectedRole"), false);
  assert.equal(selector.includes("selectRole("), false);
});

test("Desktop Settings role change has validated admin and local non-admin restart bridges", () => {
  const main = fs.readFileSync(path.join(repoRoot, "desktop", "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(repoRoot, "desktop", "preload.js"), "utf8");
  const settings = fs.readFileSync(path.join(repoRoot, "web-dashboard", "src", "pages", "Settings.jsx"), "utf8");
  const packageConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "desktop", "package.json"), "utf8"));

  assert.ok(main.includes('ipcMain.handle("restart-for-deployment-role"'));
  assert.ok(main.includes("normalizeDeploymentRole(requestedRole)"));
  assert.ok(main.includes("await stopGatewayAndWait()"));
  assert.ok(preload.includes('ipcRenderer.invoke("restart-for-deployment-role", role)'));
  assert.ok(settings.includes("window.electronAPI.restartForDeploymentRole(nextRole)"));
  assert.ok(main.includes('ipcMain.handle("switch-client-to-standalone"'));
  assert.ok(main.includes("applyClientToStandaloneConfig(readGatewayConfig())"));
  assert.ok(main.includes("环境变量 ROLE="));
  assert.ok(preload.includes('ipcRenderer.invoke("switch-client-to-standalone")'));
  assert.ok(settings.includes("window.electronAPI.switchClientToStandalone()"));
  assert.ok(settings.includes("无需管理员"));
  assert.equal(packageConfig.version, "1.6.11");
  assert.ok(packageConfig.build.files.includes("deployment-role.js"));
});
