import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { bootGateway, waitHealth } from "./_helpers.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "performance-resource-local-access-"));
const port = 32600 + Math.floor(Math.random() * 400);
const config = path.join(temp, "gateway.json");
const market = path.join(temp, "market.json");
const store = path.join(temp, "store");
const database = path.join(temp, "gateway.db");
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-appmarket-resource-runner.mjs");
let gateway;

before(async () => {
  fs.writeFileSync(config, JSON.stringify({ role: "standalone", servers: { nodeName: "local-access-test" } }));
  fs.writeFileSync(market, JSON.stringify({ projects: [] }));
  gateway = bootGateway({
    port,
    gwCfg: config,
    market,
    storeDir: store,
    dbPath: database,
    extraEnv: {
      NODE_ENV: "test",
      APPMARKET_PERF_TEST_OVERRIDES: "1",
      APPMARKET_PERF_PYTHON: process.execPath,
      APPMARKET_PERF_RUNNER: fixture,
    },
  });
  await waitHealth(port, gateway);
});

after(async () => {
  if (gateway && gateway.exitCode == null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      gateway.once("exit", () => { clearTimeout(timer); resolve(); });
      try { gateway.kill(); } catch { clearTimeout(timer); resolve(); }
    });
  }
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const request = (route, options) => fetch(`http://127.0.0.1:${port}/api/performance${route}`, options);
const forwardedLan = { "X-Forwarded-For": "127.0.0.1, 192.168.50.20" };

function rawRequest(route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: `/api/performance${route}`,
      method: "GET",
      headers,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response));
    });
    req.once("error", reject);
    req.end();
  });
}

function openSocket(headers = {}) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const timer = setTimeout(() => {
      try { socket.terminate(); } catch {}
      reject(new Error("WebSocket 连接超时"));
    }, 5000);
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        messages.push(message);
        if (message.type === "connected") {
          clearTimeout(timer);
          resolve({ socket, messages });
        }
      } catch {}
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForMessage(messages, predicate, timeout = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const message = messages.find(predicate);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等待 WebSocket 消息超时");
}

test("direct loopback may read resource configuration", async () => {
  const response = await request("/resource-config");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.ok(body.data.scripts.length >= 1);
});

test("evil browser origins and rebinding Host values are rejected before CORS", async () => {
  const evilOrigin = await request("/resource-config", {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(evilOrigin.status, 403);
  assert.equal(evilOrigin.headers.get("access-control-allow-origin"), null);

  const evilHost = await rawRequest("/resource-config", { Host: `evil.example:${port}` });
  assert.equal(evilHost.statusCode, 403);

  const viteLocal = await request("/resource-config", {
    headers: {
      Host: `localhost:${port}`,
      Origin: "http://localhost:3000",
      "X-Forwarded-For": "127.0.0.1",
    },
  });
  assert.equal(viteLocal.status, 200);
});

test("a LAN peer forwarded by the local Vite proxy cannot control a device", async () => {
  for (const [route, options] of [
    ["/resource-config", { headers: forwardedLan }],
    ["/resource-run/status", { headers: forwardedLan }],
    ["/resource-run/start", {
      method: "POST",
      headers: { ...forwardedLan, "Content-Type": "application/json" },
      body: JSON.stringify({ scriptId: "appmarket-launch-only", duration: 5, interval: 5 }),
    }],
    ["/resource-run/stop", { method: "POST", headers: forwardedLan }],
  ]) {
    const response = await request(route, options);
    assert.equal(response.status, 403, route);
    assert.match((await response.json()).error, /仅允许本机/);
  }
  const status = await (await request("/resource-run/status")).json();
  assert.equal(status.data.running, false);
});

test("forwarded LAN peers cannot read history details or raw artifacts", async () => {
  for (const route of [
    "/resource-runs",
    "/resource-runs/missing-run",
    "/resource-runs/missing-run/artifact?key=metrics_csv&download=1",
  ]) {
    const response = await request(route, { headers: forwardedLan });
    assert.equal(response.status, 403, route);
    assert.match((await response.json()).error, /仅允许本机/);
  }
});

test("the last forwarded hop is used so a prepended loopback cannot spoof locality", async () => {
  const response = await request("/resource-config", {
    headers: { "X-Forwarded-For": "127.0.0.1, 10.0.0.9, 172.16.0.5" },
  });
  assert.equal(response.status, 403);
});

test("LAN and evil-origin ordinary WebSockets receive global events but not performance resource live data", async () => {
  const clients = await Promise.all([
    openSocket({ Origin: "http://localhost:3000" }),
    openSocket({
      Origin: "http://192.168.50.20:3000",
      "X-Forwarded-For": "127.0.0.1, 192.168.50.20",
    }),
    openSocket({ Origin: "https://evil.example" }),
  ]);
  const [trusted, lan, evil] = clients;
  try {
    const response = await request("/resource-run/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ scriptId: "appmarket-launch-only", duration: 5, interval: 5 }),
    });
    assert.equal(response.status, 200, await response.text());

    await waitForMessage(
      trusted.messages,
      (message) => message.type === "performance_update" || message.type === "performance_resource_live",
    );
    for (const client of [lan, evil]) {
      await waitForMessage(
        client.messages,
        (message) => message.type === "log" && message.data?.module === "performance-resource",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));

    for (const client of [lan, evil]) {
      assert.equal(
        client.messages.some((message) => (
          message.type === "performance_resource_live"
          || (message.type === "performance_update" && message.data?.kind === "resource-run")
        )),
        false,
      );
    }
  } finally {
    for (const { socket } of clients) {
      try { socket.close(); } catch {}
    }
    const status = await request("/resource-run/status", { headers: { Origin: "http://localhost:3000" } });
    if (status.ok && (await status.json()).data?.running) {
      await request("/resource-run/stop", { method: "POST", headers: { Origin: "http://localhost:3000" } });
    }
  }
});
