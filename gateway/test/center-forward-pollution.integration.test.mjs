import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { totp } from "../services/totp.js";
import { bootGateway, waitHealth } from "./_helpers.mjs";

const roots = [];
const children = [];
const listeners = [];

after(async () => {
  for (const child of children) {
    try { child.kill(); } catch {}
  }
  await Promise.all(listeners.map((server) => new Promise((resolve) => {
    try { server.close(resolve); } catch { resolve(); }
  })));
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function issueSuperToken(baseUrl) {
  const setup = await fetch(`${baseUrl}/api/admin/auth/totp/setup`).then((response) => response.json());
  const secret = setup.data?.secret || setup.secret;
  assert.ok(secret);
  const login = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: totp(secret) }),
  });
  const body = await login.json();
  assert.equal(login.status, 200);
  assert.ok(body.ok && body.token);
  return body.token;
}

test("polluted discovery target cannot exfiltrate a browser admin bearer through any center forwarder", async () => {
  const attackerRequests = [];
  const attacker = http.createServer((req, res) => {
    attackerRequests.push({
      url: req.url,
      authorization: req.headers.authorization || "",
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, data: [] }));
  });
  listeners.push(attacker);
  await new Promise((resolve, reject) => {
    attacker.once("error", reject);
    attacker.listen(0, "127.0.0.1", resolve);
  });
  const attackerOrigin = `http://127.0.0.1:${attacker.address().port}`;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "center-forward-pollution-"));
  roots.push(root);
  const port = await reservePort();
  const cfgPath = path.join(root, "gateway.json");
  fs.writeFileSync(cfgPath, JSON.stringify({
    role: "node",
    servers: {
      discovery: false,
      distribute: false,
      peers: ["http://127.0.0.1:9"],
      selectedHost: attackerOrigin,
    },
    claudeProxyClient: {
      enabled: true,
      host: attackerOrigin,
      token: "machine-only-secret",
    },
  }, null, 2), "utf8");

  const child = bootGateway({
    port,
    role: "node",
    gwCfg: cfgPath,
    market: path.join(root, "market.json"),
    storeDir: path.join(root, "store"),
    dbPath: path.join(root, "gateway.db"),
    totpDir: path.join(root, "totp"),
    allowDiscovery: true,
  });
  children.push(child);
  await waitHealth(port, child, 30000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const exposedConfig = await fetch(`${baseUrl}/api/config`).then((response) => response.json());
  assert.equal(exposedConfig.data?.claudeProxyClient?.token, "***");
  assert.equal(JSON.stringify(exposedConfig).includes("machine-only-secret"), false);

  const unauthenticatedMutations = [
    fetch(`${baseUrl}/api/discovery/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: attackerOrigin }),
    }),
    fetch(`${baseUrl}/api/discovery/peers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: attackerOrigin }),
    }),
    fetch(`${baseUrl}/api/discovery/advertise-ip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip: "" }),
    }),
    fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        servers: { peers: [attackerOrigin], selectedHost: attackerOrigin },
        claudeProxyClient: { enabled: true, host: attackerOrigin, token: "browser-set" },
      }),
    }),
  ];
  const mutationResponses = await Promise.all(unauthenticatedMutations);
  assert.deepEqual(
    mutationResponses.map((response) => response.status),
    [401, 401, 401, 403],
  );

  const browserToken = await issueSuperToken(baseUrl);
  const authenticatedUntrustedSelection = await fetch(`${baseUrl}/api/discovery/select`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${browserToken}`,
    },
    body: JSON.stringify({ host: attackerOrigin }),
  });
  assert.equal(authenticatedUntrustedSelection.status, 403);
  assert.equal(
    (await authenticatedUntrustedSelection.json()).code,
    "DISCOVERY_CENTER_NOT_TRUSTED",
  );

  const guardedRequests = [
    ["DevBench", "/api/devbench/project-defs"],
    ["feedback", "/api/feedback"],
    ["work-report repository helper", "/api/report/repositories"],
  ];
  for (const [name, pathname] of guardedRequests) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      headers: { Authorization: `Bearer ${browserToken}` },
    });
    assert.equal(response.status, 503, `${name} 必须在联网前失败关闭`);
  }

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(attackerRequests, []);
}, { timeout: 50000 });

test("trusted peer redirects cannot forward the machine token to a second origin", async () => {
  const attackerRequests = [];
  const attacker = http.createServer((req, res) => {
    attackerRequests.push(req.headers.authorization || "");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, data: [] }));
  });
  listeners.push(attacker);
  await new Promise((resolve, reject) => {
    attacker.once("error", reject);
    attacker.listen(0, "127.0.0.1", resolve);
  });
  const attackerOrigin = `http://127.0.0.1:${attacker.address().port}`;

  const peerRequests = [];
  const redirectingPeer = http.createServer((req, res) => {
    peerRequests.push(req.headers.authorization || "");
    res.writeHead(302, { Location: `${attackerOrigin}/capture` });
    res.end();
  });
  listeners.push(redirectingPeer);
  await new Promise((resolve, reject) => {
    redirectingPeer.once("error", reject);
    redirectingPeer.listen(0, "127.0.0.1", resolve);
  });
  const peerOrigin = `http://127.0.0.1:${redirectingPeer.address().port}`;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "center-forward-redirect-"));
  roots.push(root);
  const port = await reservePort();
  const cfgPath = path.join(root, "gateway.json");
  fs.writeFileSync(cfgPath, JSON.stringify({
    role: "node",
    servers: {
      discovery: false,
      distribute: false,
      peers: [peerOrigin],
      selectedHost: peerOrigin,
    },
    claudeProxyClient: {
      enabled: true,
      host: peerOrigin,
      token: "machine-only-secret",
    },
  }, null, 2), "utf8");
  const child = bootGateway({
    port,
    role: "node",
    gwCfg: cfgPath,
    market: path.join(root, "market.json"),
    storeDir: path.join(root, "store"),
    dbPath: path.join(root, "gateway.db"),
    totpDir: path.join(root, "totp"),
    allowDiscovery: true,
  });
  children.push(child);
  await waitHealth(port, child, 30000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const browserToken = await issueSuperToken(baseUrl);

  const response = await fetch(`${baseUrl}/api/devbench/project-defs`, {
    headers: { Authorization: `Bearer ${browserToken}` },
  });
  assert.equal(response.status, 502);
  assert.ok(peerRequests.length >= 1);
  assert.ok(peerRequests.every((value) => value === "Bearer machine-only-secret"));
  assert.equal(peerRequests.includes(`Bearer ${browserToken}`), false);
  assert.deepEqual(attackerRequests, []);
}, { timeout: 50000 });

test("production node uses M2M auth but never delegates its local TOTP super identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "center-forward-m2m-"));
  roots.push(root);
  const centerPort = await reservePort();
  const nodePort = await reservePort();
  const centerOrigin = `http://127.0.0.1:${centerPort}`;
  const centerCfg = path.join(root, "center.json");
  const nodeCfg = path.join(root, "node.json");
  const centerMarket = path.join(root, "center-market.json");
  const nodeMarket = path.join(root, "node-market.json");
  fs.writeFileSync(centerMarket, JSON.stringify({ projectDefs: [] }), "utf8");
  fs.writeFileSync(nodeMarket, JSON.stringify({ projectDefs: [] }), "utf8");
  fs.writeFileSync(centerCfg, JSON.stringify({
    role: "standalone",
    servers: {
      discovery: false,
      distribute: false,
      inboundToken: "shared-machine-secret",
    },
  }), "utf8");
  fs.writeFileSync(nodeCfg, JSON.stringify({
    role: "node",
    servers: {
      discovery: false,
      distribute: false,
      peers: [centerOrigin],
      selectedHost: centerOrigin,
    },
    claudeProxyClient: {
      enabled: true,
      host: centerOrigin,
      token: "shared-machine-secret",
    },
  }), "utf8");

  const center = bootGateway({
    port: centerPort,
    role: "standalone",
    gwCfg: centerCfg,
    market: centerMarket,
    storeDir: path.join(root, "center-store"),
    dbPath: path.join(root, "center.db"),
    totpDir: path.join(root, "center-totp"),
    extraEnv: { NODE_ENV: "production" },
  });
  const node = bootGateway({
    port: nodePort,
    role: "node",
    gwCfg: nodeCfg,
    market: nodeMarket,
    storeDir: path.join(root, "node-store"),
    dbPath: path.join(root, "node.db"),
    totpDir: path.join(root, "node-totp"),
    extraEnv: { NODE_ENV: "production" },
    allowDiscovery: true,
  });
  children.push(center, node);
  await Promise.all([
    waitHealth(centerPort, center, 30000),
    waitHealth(nodePort, node, 30000),
  ]);
  const nodeOrigin = `http://127.0.0.1:${nodePort}`;
  const browserToken = await issueSuperToken(nodeOrigin);

  const directCenterUse = await fetch(`${centerOrigin}/api/devbench/project-defs`, {
    headers: { Authorization: `Bearer ${browserToken}` },
  });
  assert.equal(directCenterUse.status, 401, "node 浏览器会话不得成为 center 的 bearer");

  const unauthenticatedReplication = await fetch(`${centerOrigin}/api/discovery/shared-bundle`);
  assert.equal(unauthenticatedReplication.status, 401);
  const browserReplication = await fetch(`${centerOrigin}/api/discovery/shared-bundle`, {
    headers: { Authorization: `Bearer ${browserToken}` },
  });
  assert.equal(browserReplication.status, 401, "浏览器会话不得读取 peer replication 接口");
  const machineReplication = await fetch(`${centerOrigin}/api/discovery/shared-bundle`, {
    headers: { Authorization: "Bearer shared-machine-secret" },
  });
  assert.equal(machineReplication.status, 200);

  const forwardedWrite = await fetch(`${nodeOrigin}/api/devbench/project-defs`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${browserToken}`,
    },
    body: JSON.stringify({
      id: "m2m-forwarded-repository",
      name: "M2M 转发仓库",
      https: "https://example.invalid/team/repository.git",
    }),
  });
  const forwardedBody = await forwardedWrite.json();
  assert.equal(forwardedWrite.status, 403, JSON.stringify(forwardedBody));
  assert.equal(forwardedBody.ok, false);

  const nodeRead = await fetch(`${nodeOrigin}/api/devbench/project-defs`, {
    headers: { Authorization: `Bearer ${browserToken}` },
  }).then((response) => response.json());
  assert.equal(nodeRead.data.some((entry) => entry.id === "m2m-forwarded-repository"), false);
}, { timeout: 60000 });
