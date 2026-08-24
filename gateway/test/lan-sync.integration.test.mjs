import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const gatewayRoot = path.resolve(import.meta.dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lan-sync-e2e-"));
const children = new Set();

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function freeUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

function nodeEnvironment(name, port, peerPort, {
  syncMode = "peer",
  teamConfigSpace = "team/e2e/vehicle-source",
  discovery = false,
  discoveryPort = 48900,
  discoverySeeds = [],
} = {}) {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(root, { recursive: true });
  const configPath = path.join(root, "gateway.json");
  const environment = {
    ...process.env,
    PORT: String(port),
    ROLE: "standalone",
    GATEWAY_CONFIG_PATH: configPath,
    GATEWAY_DB_PATH: path.join(root, "data.db"),
    DEVBENCH_CONFIG_PATH: path.join(root, "market.json"),
    DEVBENCH_LOCAL_PROJECTS_PATH: path.join(root, "projects.json"),
    DEVBENCH_STORE_DIR: path.join(root, "store"),
    LAN_SYNC_IDENTITY_PATH: path.join(root, "identity.json"),
    DEVBENCH_SYNC_SCOPE: "lan-sync-e2e",
    DEVBENCH_PEER_METADATA_INTERVAL_MS: "5000",
    DEVBENCH_PEER_RECONCILE_INTERVAL_MS: "30000",
    CLOUD_URL: "http://127.0.0.1:1",
  };
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({
      role: "standalone",
      claudeProxy: { enabled: false },
      servers: {
        nodeId: name,
        nodeName: name,
        discovery,
        discoveryPort,
        discoverySeeds,
        peers: syncMode === "peer" ? [`http://127.0.0.1:${peerPort}`] : [],
      },
      lanSync: {
        syncMode,
        allowInsecureTransport: true,
        teamConfigSpace,
        legacyCompatibility: false,
      },
      teambition: { projects: [{ id: "project-a", name: "Project A" }] },
    }, null, 2));
    fs.writeFileSync(environment.DEVBENCH_CONFIG_PATH, "{}");
  }
  return environment;
}

function runHelper(environment, source, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: gatewayRoot,
      env: { ...environment, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`helper exit ${code}: ${stderr || stdout}`));
    });
  });
}

async function bootstrap(environment, host) {
  const output = await runHelper(environment, `
    const sync = await import("./services/lan-sync/index.js");
    const auth = await import("./services/admin-auth.js");
    console.log(JSON.stringify({
      bundle: sync.localPairingBundle(process.env.NODE_HOST),
      token: auth.issueToken({ role: "super", name: "E2E super", dingUserid: null }),
    }));
  `, { NODE_HOST: host });
  return JSON.parse(output.split(/\r?\n/).at(-1));
}

async function pair(environment, bundle) {
  const output = await runHelper(environment, `
    const sync = await import("./services/lan-sync/index.js");
    console.log(JSON.stringify(sync.pairMember(JSON.parse(process.env.PAIR_BUNDLE))));
  `, { PAIR_BUNDLE: JSON.stringify(bundle) });
  return JSON.parse(output.split(/\r?\n/).at(-1));
}

function startGateway(environment) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: gatewayRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.logs = "";
  child.stdout.on("data", (chunk) => { child.logs += chunk; });
  child.stderr.on("data", (chunk) => { child.logs += chunk; });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function stopGateway(child) {
  if (!child || child.exitCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(() => {
      if (child.exitCode == null) child.kill();
      resolve();
    }, 5000)),
  ]);
}

async function waitFor(url, predicate, { timeout = 20_000, headers = {} } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers });
      const json = await response.json();
      if (predicate(json, response)) return json;
      lastError = new Error(JSON.stringify(json));
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastError || new Error(`等待超时：${url}`);
}

async function publish(
  port,
  token,
  branch,
  idempotencyKey,
  configSpace = "team/e2e/vehicle-source",
) {
  const response = await fetch(`http://127.0.0.1:${port}/api/devbench/config-publications`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      configSpace,
      projectId: "project-a",
      idempotencyKey,
      changes: [{
        flavor: "avatr8678",
        action: "set",
        mapping: {
          apps: [{
            appName: "应用市场",
            repos: [{ repoId: "appMarket", branch, flavor: "avatr8678" }],
          }],
        },
      }],
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true, JSON.stringify(body));
  return body.data;
}

after(async () => {
  await Promise.all([...children].map(stopGateway));
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("一次性加入码建立无中心加密同步，加入和只读打开不会外发陈旧本机配置", { timeout: 60_000 }, async () => {
  const portA = await freePort();
  const portB = await freePort();
  const portC = await freePort();
  const envA = nodeEnvironment("invite-node-a", portA, portB, { syncMode: "disabled" });
  const envB = nodeEnvironment("invite-node-b", portB, portA, {
    syncMode: "disabled",
    teamConfigSpace: "team/vehicle-source",
  });
  const envC = nodeEnvironment("invite-node-c", portC, portA, { syncMode: "disabled" });
  await runHelper(envA, `
    const store = await import("./services/devbench/store.js");
    store.setVehicleMapping("project-a", "geelyp162", {
      apps: [{ appName: "应用市场", repos: [{ repoId: "appMarket", branch: "release/geelyp162", flavor: "geelyp162" }] }],
    });
  `);
  await runHelper(envB, `
    const store = await import("./services/devbench/store.js");
    store.setVehicleMapping("project-a", "avatr8678", {
      apps: [{ appName: "应用市场", repos: [{ repoId: "appMarket", branch: "local-stale", flavor: "avatr8678" }] }],
    });
  `);
  const adminA = await bootstrap(envA, `http://127.0.0.1:${portA}`);
  const adminB = await bootstrap(envB, `http://127.0.0.1:${portB}`);
  const adminC = await bootstrap(envC, `http://127.0.0.1:${portC}`);
  const gatewayA = startGateway(envA);
  const gatewayB = startGateway(envB);
  const gatewayC = startGateway(envC);
  const headersA = { Authorization: `Bearer ${adminA.token}` };
  const headersB = { Authorization: `Bearer ${adminB.token}` };
  try {
    await waitFor(`http://127.0.0.1:${portA}/api/health`, (body) => body.status === "ok");
    await waitFor(`http://127.0.0.1:${portB}/api/health`, (body) => body.status === "ok");
    await waitFor(`http://127.0.0.1:${portC}/api/health`, (body) => body.status === "ok");

    // Simulate a node that belonged to an older group and still has a signed
    // operation under the same logical config-space name. Joining must discard
    // that transport history while preserving its local materialized snapshot.
    const stalePublication = await publish(
      portB,
      adminB.token,
      "local-stale-history",
      "invite-stale-history",
      "team/vehicle-source",
    );
    assert.ok(stalePublication.changeSetId);

    const initializedByOpen = await fetch(`http://127.0.0.1:${portB}/api/devbench/remote-config/initialize`, {
      method: "POST",
      headers: { ...headersB, "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "project-open" }),
    }).then((response) => response.json());
    assert.equal(initializedByOpen.ok, true, JSON.stringify(initializedByOpen));

    const invitationResponse = await fetch(`http://127.0.0.1:${portA}/api/lan-sync/invitations`, {
      method: "POST",
      headers: { ...headersA, "Content-Type": "application/json" },
      body: JSON.stringify({ host: `http://127.0.0.1:${portA}`, seedExistingConfig: true }),
    });
    const invitation = await invitationResponse.json();
    assert.equal(invitationResponse.status, 200, JSON.stringify(invitation));
    assert.ok(invitation.data?.seededOperations >= 1, JSON.stringify(invitation));
    assert.equal(invitation.data?.configSpace, "team/vehicle-source");

    const joinResponse = await fetch(`http://127.0.0.1:${portB}/api/lan-sync/invitations/join`, {
      method: "POST",
      headers: { ...headersB, "Content-Type": "application/json" },
      body: JSON.stringify({ code: invitation.data.code, host: `http://127.0.0.1:${portB}` }),
    });
    const joined = await joinResponse.json();
    assert.equal(joinResponse.status, 200, JSON.stringify(joined));
    assert.equal(joined.data?.syncMode, "peer");
    assert.ok(joined.data?.discardedSyncState?.operations >= 1, JSON.stringify(joined));

    await waitFor(
      `http://127.0.0.1:${portB}/api/devbench/remote-config?projectId=project-a`,
      (body) => body.data?.vehicleMap?.geelyp162?.entries?.[0]?.branch === "release/geelyp162",
      { headers: headersB },
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      await fetch(`http://127.0.0.1:${portB}/api/devbench/remote-config?projectId=project-a`, { headers: headersB });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const sourceAfterRead = await fetch(
      `http://127.0.0.1:${portA}/api/devbench/remote-config?projectId=project-a`,
      { headers: headersA },
    ).then((response) => response.json());
    assert.equal(
      Object.hasOwn(sourceAfterRead.data?.vehicleMap || {}, "avatr8678"),
      false,
      "加入或打开陈旧节点不得把其本机旧车型外发",
    );
    const sourceOpenProject = await fetch(
      `http://127.0.0.1:${portA}/api/devbench/remote-config?projectId=project-open`,
      { headers: headersA },
    ).then((response) => response.json());
    assert.deepEqual(
      sourceOpenProject.data?.vehicleMap || {},
      {},
      "打开车型页触发的本机初始化不得成为团队发布",
    );

    const contextB = await fetch(
      `http://127.0.0.1:${portB}/api/devbench/remote-config?projectId=project-a`,
      { headers: headersB },
    ).then((response) => response.json());
    const publicationResponse = await fetch(`http://127.0.0.1:${portB}/api/devbench/config-publications`, {
      method: "POST",
      headers: { ...headersB, "Content-Type": "application/json" },
      body: JSON.stringify({
        configSpace: "team/vehicle-source",
        projectId: "project-a",
        idempotencyKey: "invite-explicit-admin-edit",
        changes: [{
          flavor: "avatr8678",
          action: "set",
          baseRevision: contextB.data.sync.entityRevisions.avatr8678 || "0",
          mapping: {
            apps: [{ appName: "应用市场", repos: [{ repoId: "appMarket", branch: "admin-approved", flavor: "avatr8678" }] }],
          },
        }],
      }),
    });
    const publication = await publicationResponse.json();
    assert.equal(publicationResponse.status, 200, JSON.stringify(publication));
    await waitFor(
      `http://127.0.0.1:${portA}/api/devbench/remote-config?projectId=project-a`,
      (body) => body.data?.vehicleMap?.avatr8678?.entries?.[0]?.branch === "admin-approved",
      { headers: headersA },
    );

    const secondInvitationResponse = await fetch(`http://127.0.0.1:${portA}/api/lan-sync/invitations`, {
      method: "POST",
      headers: { ...headersA, "Content-Type": "application/json" },
      body: JSON.stringify({ host: `http://127.0.0.1:${portA}`, seedExistingConfig: true }),
    });
    const secondInvitation = await secondInvitationResponse.json();
    assert.equal(secondInvitationResponse.status, 200, JSON.stringify(secondInvitation));
    const joinCResponse = await fetch(`http://127.0.0.1:${portC}/api/lan-sync/invitations/join`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminC.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code: secondInvitation.data.code, host: `http://127.0.0.1:${portC}` }),
    });
    const joinedC = await joinCResponse.json();
    assert.equal(joinCResponse.status, 200, JSON.stringify(joinedC));
    await waitFor(
      `http://127.0.0.1:${portB}/api/lan-sync/diagnostics`,
      (body) => body.data?.members?.some((member) => member.nodeId === adminC.bundle.nodeId),
      { headers: headersB },
    );
    await waitFor(
      `http://127.0.0.1:${portC}/api/lan-sync/diagnostics`,
      (body) => body.data?.members?.some((member) => member.nodeId === adminB.bundle.nodeId),
      { headers: { Authorization: `Bearer ${adminC.token}` } },
    );
    const publishCResponse = await fetch(`http://127.0.0.1:${portC}/api/devbench/config-publications`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminC.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        configSpace: "team/vehicle-source",
        projectId: "project-a",
        idempotencyKey: "invite-third-node-admin-edit",
        changes: [{
          flavor: "zeekr9x",
          action: "set",
          baseRevision: "0",
          mapping: {
            apps: [{ appName: "应用市场", repos: [{ repoId: "appMarket", branch: "admin-third-node", flavor: "zeekr9x" }] }],
          },
        }],
      }),
    });
    const publishedC = await publishCResponse.json();
    assert.equal(publishCResponse.status, 200, JSON.stringify(publishedC));
    await waitFor(
      `http://127.0.0.1:${portB}/api/devbench/remote-config?projectId=project-a`,
      (body) => body.data?.vehicleMap?.zeekr9x?.entries?.[0]?.branch === "admin-third-node",
      { headers: headersB },
    );
  } finally {
    await stopGateway(gatewayC);
    await stopGateway(gatewayB);
    await stopGateway(gatewayA);
  }
});

test("管理员正常发布后其它 Gateway 无需设置即可通过 UDP 发现和 WebSocket 自动同步", { timeout: 60_000 }, async () => {
  const portA = await freePort();
  const portB = await freePort();
  const discoveryPort = await freeUdpPort();
  const envA = nodeEnvironment("automatic-node-a", portA, portB, {
    syncMode: "disabled",
    teamConfigSpace: "team/vehicle-source",
    discovery: true,
    discoveryPort,
  });
  const envB = nodeEnvironment("automatic-node-b", portB, portA, {
    syncMode: "disabled",
    teamConfigSpace: "team/vehicle-source",
    discovery: true,
    discoveryPort,
  });
  await runHelper(envA, `
    const store = await import("./services/devbench/store.js");
    store.setVehicleMapping("project-a", "geelyp162", {
      apps: [{ appName: "应用市场", repos: [{ repoId: "appMarket", branch: "release/existing-geelyp162", flavor: "geelyp162" }] }],
    });
  `);
  await runHelper(envB, `
    const store = await import("./services/devbench/store.js");
    store.setVehicleMapping("project-a", "local-stale", {
      apps: [{ appName: "应用市场", repos: [{ repoId: "appMarket", branch: "must-not-upload", flavor: "local-stale" }] }],
    });
  `);
  const adminA = await bootstrap(envA, `http://127.0.0.1:${portA}`);
  const adminB = await bootstrap(envB, `http://127.0.0.1:${portB}`);
  const gatewayA = startGateway(envA);
  let gatewayB = null;
  try {
    await waitFor(`http://127.0.0.1:${portA}/api/health`, (body) => body.status === "ok");

    const publication = await publish(
      portA,
      adminA.token,
      "release/automatic",
      "automatic-first-admin-publish",
      "team/vehicle-source",
    );
    assert.equal(publication.publicationScope, "team");

    // 让接收端错过发布节点的启动/发布广播，证明按钮会主动发起发现，
    // 而不是依赖 90 秒兜底广播碰巧完成同步。
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    gatewayB = startGateway(envB);
    await waitFor(`http://127.0.0.1:${portB}/api/health`, (body) => body.status === "ok");

    const unauthorizedSync = await fetch(`http://127.0.0.1:${portB}/api/devbench/vehicle-map/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "project-a" }),
    });
    assert.equal(unauthorizedSync.status, 401);

    const manualSync = await fetch(`http://127.0.0.1:${portB}/api/devbench/vehicle-map/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminB.token}`,
      },
      body: JSON.stringify({ projectId: "project-a" }),
    });
    const manualSyncBody = await manualSync.json();
    assert.equal(manualSync.status, 200, JSON.stringify(manualSyncBody));
    assert.match(manualSyncBody.data?.discovery?.requestId || "", /^[a-f0-9]{32}$/);

    const synchronized = await waitFor(
      `http://127.0.0.1:${portB}/api/devbench/remote-config?projectId=project-a`,
      (body) => body.data?.vehicleMap?.avatr8678?.entries?.[0]?.branch === "release/automatic"
        && body.data?.vehicleMap?.geelyp162?.entries?.[0]?.branch === "release/existing-geelyp162",
      { headers: { Authorization: `Bearer ${adminB.token}` }, timeout: 30_000 },
    );
    assert.equal(synchronized.data.sync.syncMode, "peer");
    assert.ok(synchronized.data.sync.members.some((member) => member.online));

    const source = await fetch(
      `http://127.0.0.1:${portA}/api/devbench/remote-config?projectId=project-a`,
      { headers: { Authorization: `Bearer ${adminA.token}` } },
    ).then((response) => response.json());
    assert.equal(
      Object.hasOwn(source.data?.vehicleMap || {}, "local-stale"),
      false,
      "自动加入节点的本机旧配置不得反向播种到发布节点",
    );
  } finally {
    await Promise.all([stopGateway(gatewayA), gatewayB ? stopGateway(gatewayB) : Promise.resolve()]);
  }
});

test("独立 Gateway 第一次受保护发布会自动建组并供同服务浏览器读取", { timeout: 30_000 }, async () => {
  const port = await freePort();
  const environment = nodeEnvironment("node-standalone", port, port, { syncMode: "disabled" });
  const admin = await bootstrap(environment, `http://127.0.0.1:${port}`);
  const gateway = startGateway(environment);
  try {
    await waitFor(`http://127.0.0.1:${port}/api/health`, (body) => body.status === "ok");
    const response = await fetch(`http://127.0.0.1:${port}/api/devbench/config-publications`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${admin.token}`,
      },
      body: JSON.stringify({
        configSpace: "team/e2e/vehicle-source",
        projectId: "project-a",
        idempotencyKey: "standalone-geelyp162",
        changes: [{
          flavor: "geelyp162",
          action: "set",
          baseRevision: "0",
          mapping: {
            apps: [{
              appName: "应用市场",
              repos: [{ repoId: "appMarket", branch: "release/geely-p162", flavor: "geelyp162" }],
            }],
          },
        }],
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.data?.publicationScope, "team");
    assert.deepEqual(body.data?.deliveries, []);

    const visible = await fetch(
      `http://127.0.0.1:${port}/api/devbench/remote-config?projectId=project-a`,
      { headers: { Authorization: `Bearer ${admin.token}` } },
    ).then((result) => result.json());
    const visibleSummary = {
      ok: visible.ok,
      code: visible.code,
      error: visible.error,
      projectId: visible.data?.projectId,
      vehicleKeys: Object.keys(visible.data?.vehicleMap || {}),
    };
    assert.equal(
      Object.hasOwn(visible.data?.vehicleMap || {}, "geelyp162"),
      true,
      JSON.stringify(visibleSummary),
    );
  } finally {
    await stopGateway(gateway);
  }
});

test("两 Gateway 配对后通过持久 WebSocket 增量同步、ACK 并在离线重启后续传", { timeout: 90_000 }, async () => {
  const portA = await freePort();
  const portB = await freePort();
  const envA = nodeEnvironment("node-a", portA, portB);
  const envB = nodeEnvironment("node-b", portB, portA);
  const adminA = await bootstrap(envA, `http://127.0.0.1:${portA}`);
  const adminB = await bootstrap(envB, `http://127.0.0.1:${portB}`);
  await pair(envA, adminB.bundle);
  await pair(envB, adminA.bundle);

  let gatewayA = startGateway(envA);
  let gatewayB = startGateway(envB);
  await waitFor(`http://127.0.0.1:${portA}/api/health`, (body) => body.status === "ok");
  await waitFor(`http://127.0.0.1:${portB}/api/health`, (body) => body.status === "ok");
  const authHeader = { Authorization: `Bearer ${adminA.token}` };
  const authHeaderB = { Authorization: `Bearer ${adminB.token}` };
  await waitFor(
    `http://127.0.0.1:${portA}/api/lan-sync/diagnostics`,
    (body) => body.ok && body.data?.metrics?.lan_sync_connected_peers === 1,
    { headers: authHeader },
  );

  const browserSocket = new WebSocket(`ws://127.0.0.1:${portB}/ws`);
  await new Promise((resolve, reject) => {
    browserSocket.once("open", resolve);
    browserSocket.once("error", reject);
  });
  const browserChangeEvent = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("B 浏览器未收到 shared_config_changed")), 5000);
    browserSocket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (message.type !== "shared_config_changed"
        || !message.data?.projectIds?.includes("project-a")) return;
      clearTimeout(timeout);
      resolve(message);
    });
  });
  const first = await publish(portA, adminA.token, "release/online", "e2e-online");
  await waitFor(
    `http://127.0.0.1:${portB}/api/devbench/remote-config?projectId=project-a`,
    (body) => body.data?.vehicleMap?.avatr8678?.entries?.[0]?.branch === "release/online",
    { headers: authHeaderB },
  );
  await waitFor(
    `http://127.0.0.1:${portA}/api/devbench/config-publications/${first.changeSetId}`,
    (body) => body.data?.deliveries?.[0]?.status === "applied",
    { headers: authHeader },
  );
  const browserEvent = await browserChangeEvent;
  assert.equal(browserEvent.data.changeSetId, first.changeSetId);
  browserSocket.close();

  const manualSyncResponse = await fetch(`http://127.0.0.1:${portA}/api/devbench/vehicle-map/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader },
    body: JSON.stringify({ projectId: "project-a" }),
  });
  const manualSyncBody = await manualSyncResponse.json();
  assert.equal(manualSyncResponse.status, 200, JSON.stringify(manualSyncBody));
  assert.equal(manualSyncBody.data?.status, "requested");
  assert.equal(manualSyncBody.data?.requestedPeers, 1);

  const visibilityLatencyMs = [];
  for (let index = 0; index < 20; index++) {
    const branch = `release/latency-${index}`;
    const startedAt = performance.now();
    await publish(portA, adminA.token, branch, `e2e-latency-${index}`);
    await waitFor(
      `http://127.0.0.1:${portB}/api/devbench/remote-config?projectId=project-a`,
      (body) => body.data?.vehicleMap?.avatr8678?.entries?.[0]?.branch === branch,
      { timeout: 5000, headers: authHeaderB },
    );
    visibilityLatencyMs.push(performance.now() - startedAt);
  }
  const sortedLatency = [...visibilityLatencyMs].sort((left, right) => left - right);
  const percentile = (value) => sortedLatency[Math.max(0, Math.ceil(sortedLatency.length * value) - 1)];
  const p95 = percentile(0.95);
  const p99 = percentile(0.99);
  console.log(`LAN_SYNC_LATENCY ${JSON.stringify({
    samples: visibilityLatencyMs.length,
    p95Ms: Number(p95.toFixed(2)),
    p99Ms: Number(p99.toFixed(2)),
    maxMs: Number(Math.max(...visibilityLatencyMs).toFixed(2)),
  })}`);
  assert.ok(p95 < 500, `局域网可见延迟 P95 ${p95.toFixed(2)}ms 应小于 500ms`);
  assert.ok(p99 < 1000, `局域网可见延迟 P99 ${p99.toFixed(2)}ms 应小于 1000ms`);

  const dependencyContext = await fetch(
    `http://127.0.0.1:${portA}/api/devbench/remote-config?projectId=project-a`,
    { headers: authHeader },
  ).then((response) => response.json());
  const dependencyResponse = await fetch(`http://127.0.0.1:${portA}/api/devbench/config-publications`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminA.token}` },
    body: JSON.stringify({
      configSpace: "team/e2e/vehicle-source",
      projectId: "project-a",
      idempotencyKey: "e2e-project-def-atomic",
      projectDefs: [{
        action: "set",
        definition: {
          id: "e2e-dependency",
          name: "E2E Dependency",
          https: "https://example.com/e2e-dependency.git",
          projectType: "sdk",
        },
        baseRevision: "0",
      }],
      changes: [{
        flavor: "avatr8678",
        action: "set",
        baseRevision: dependencyContext.data.sync.entityRevisions.avatr8678,
        mapping: {
          apps: [{
            appName: "应用市场",
            repos: [{
              repoId: "e2e-dependency",
              branch: "release/dependency",
              flavor: "avatr8678",
            }],
          }],
        },
      }],
    }),
  });
  const dependencyBody = await dependencyResponse.json();
  assert.equal(dependencyResponse.status, 200, JSON.stringify(dependencyBody));
  assert.deepEqual(
    dependencyBody.data.ops.map((op) => op.entityType),
    ["project-definition", "vehicle"],
  );
  await waitFor(
    `http://127.0.0.1:${portB}/api/devbench/remote-config?projectId=project-a`,
    (body) => body.data?.projectDefs?.some((def) => def.id === "e2e-dependency")
      && body.data?.vehicleMap?.avatr8678?.entries?.[0]?.projectId === "e2e-dependency",
    { headers: authHeaderB },
  );

  await stopGateway(gatewayB);
  const context = await fetch(
    `http://127.0.0.1:${portA}/api/devbench/remote-config?projectId=project-a`,
    { headers: authHeader },
  ).then((r) => r.json());
  const secondResponse = await fetch(`http://127.0.0.1:${portA}/api/devbench/config-publications`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminA.token}` },
    body: JSON.stringify({
      configSpace: "team/e2e/vehicle-source",
      projectId: "project-a",
      idempotencyKey: "e2e-offline",
      changes: [{
        flavor: "avatr8678",
        action: "set",
        mapping: {
          apps: [{ appName: "应用市场", repos: [{ repoId: "appMarket", branch: "release/offline", flavor: "avatr8678" }] }],
        },
        baseRevision: context.data.sync.entityRevisions.avatr8678,
      }],
    }),
  });
  const secondBody = await secondResponse.json();
  assert.equal(secondResponse.status, 200, JSON.stringify(secondBody));

  gatewayB = startGateway(envB);
  await waitFor(`http://127.0.0.1:${portB}/api/health`, (body) => body.status === "ok");
  await waitFor(
    `http://127.0.0.1:${portB}/api/devbench/remote-config?projectId=project-a`,
    (body) => body.data?.vehicleMap?.avatr8678?.entries?.[0]?.branch === "release/offline",
    { timeout: 30_000, headers: authHeaderB },
  );
  const secondStatus = await waitFor(
    `http://127.0.0.1:${portA}/api/devbench/config-publications/${secondBody.data.changeSetId}`,
    (body) => body.data?.deliveries?.[0]?.status === "applied",
    { timeout: 30_000, headers: authHeader },
  );
  assert.equal(
    secondStatus.data.deliveries[0].attempts,
    1,
    "HELLO range 与 pending delivery 不应重复发送同一变更集",
  );

  // 两端在断网期间基于同一 revision 分别发布不同值，重连后必须留痕冲突，
  // 不能用最后到达或本机时钟静默覆盖。
  await stopGateway(gatewayB);
  await stopGateway(gatewayA);
  gatewayA = startGateway(envA);
  await waitFor(`http://127.0.0.1:${portA}/api/health`, (body) => body.status === "ok");
  await publish(portA, adminA.token, "release/concurrent-a", "e2e-conflict-a");
  await stopGateway(gatewayA);

  gatewayB = startGateway(envB);
  await waitFor(`http://127.0.0.1:${portB}/api/health`, (body) => body.status === "ok");
  await publish(portB, adminB.token, "release/concurrent-b", "e2e-conflict-b");
  await stopGateway(gatewayB);

  gatewayA = startGateway(envA);
  gatewayB = startGateway(envB);
  await waitFor(`http://127.0.0.1:${portA}/api/health`, (body) => body.status === "ok");
  await waitFor(`http://127.0.0.1:${portB}/api/health`, (body) => body.status === "ok");
  await waitFor(
    `http://127.0.0.1:${portA}/api/devbench/config-conflicts`,
    (body) => body.ok && body.data?.length >= 1,
    { timeout: 30_000, headers: authHeader },
  );
  const localA = await fetch(
    `http://127.0.0.1:${portA}/api/devbench/remote-config?projectId=project-a`,
    { headers: authHeader },
  ).then((r) => r.json());
  const localB = await fetch(
    `http://127.0.0.1:${portB}/api/devbench/remote-config?projectId=project-a`,
    { headers: authHeaderB },
  ).then((r) => r.json());
  assert.equal(localA.data.vehicleMap.avatr8678.entries[0].branch, "release/concurrent-a");
  assert.equal(localB.data.vehicleMap.avatr8678.entries[0].branch, "release/concurrent-b");

  const conflictA = await waitFor(
    `http://127.0.0.1:${portA}/api/devbench/config-conflicts`,
    (body) => body.ok && body.data?.length >= 1,
    { timeout: 30_000, headers: authHeader },
  );
  await waitFor(
    `http://127.0.0.1:${portB}/api/devbench/config-conflicts`,
    (body) => body.ok && body.data?.length >= 1,
    { timeout: 30_000, headers: authHeaderB },
  );
  const resolveResponse = await fetch(
    `http://127.0.0.1:${portA}/api/devbench/config-conflicts/${conflictA.data[0].conflictId}/resolve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader },
      body: JSON.stringify({
        mapping: localA.data.vehicleMap.avatr8678,
        idempotencyKey: "e2e-conflict-resolve-a",
      }),
    },
  );
  const resolveBody = await resolveResponse.json();
  assert.equal(resolveResponse.status, 200, JSON.stringify(resolveBody));
  await waitFor(
    `http://127.0.0.1:${portB}/api/devbench/remote-config?projectId=project-a`,
    (body) => body.data?.vehicleMap?.avatr8678?.entries?.[0]?.branch === "release/concurrent-a",
    { timeout: 30_000, headers: authHeaderB },
  );
  await waitFor(
    `http://127.0.0.1:${portA}/api/devbench/config-conflicts`,
    (body) => body.ok && body.data?.length === 0,
    { timeout: 30_000, headers: authHeader },
  );
  await waitFor(
    `http://127.0.0.1:${portB}/api/devbench/config-conflicts`,
    (body) => body.ok && body.data?.length === 0,
    { timeout: 30_000, headers: authHeaderB },
  );

  await stopGateway(gatewayB);
  await stopGateway(gatewayA);
});

test("跨子网手动 peer 保存后立即探测、自动入组并同步车型配置", { timeout: 45_000 }, async () => {
  const portA = await freePort();
  const portB = await freePort();
  const discoveryPort = await freeUdpPort();
  const envA = nodeEnvironment("manual-peer-node-a", portA, portB, {
    syncMode: "disabled",
    teamConfigSpace: "team/vehicle-source",
    discovery: true,
    discoveryPort,
  });
  const envB = nodeEnvironment("manual-peer-node-b", portB, portA, {
    syncMode: "disabled",
    teamConfigSpace: "team/vehicle-source",
    discovery: false,
    discoveryPort,
  });
  const adminA = await bootstrap(envA, `http://127.0.0.1:${portA}`);
  const adminB = await bootstrap(envB, `http://127.0.0.1:${portB}`);
  const gatewayA = startGateway(envA);
  const gatewayB = startGateway(envB);
  try {
    await waitFor(`http://127.0.0.1:${portA}/api/health`, (body) => body.status === "ok");
    await waitFor(`http://127.0.0.1:${portB}/api/health`, (body) => body.status === "ok");
    await publish(
      portA,
      adminA.token,
      "release/manual-peer",
      "manual-peer-first-publish",
      "team/vehicle-source",
    );

    const response = await fetch(`http://127.0.0.1:${portB}/api/discovery/peers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminB.token}`,
      },
      body: JSON.stringify({ host: `http://127.0.0.1:${portA}` }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.meta?.probe?.reachable, true, JSON.stringify(body));
    assert.equal(body.meta?.probe?.joined, true, JSON.stringify(body));
    assert.equal(body.meta?.probe?.reciprocalAnnounced, true, JSON.stringify(body));

    await waitFor(
      `http://127.0.0.1:${portA}/api/devbench/remote-config?projectId=project-a`,
      (result) => result.data?.sync?.members?.some((member) => member.nodeName === "manual-peer-node-b"),
      { timeout: 5000, headers: { Authorization: `Bearer ${adminA.token}` } },
    );

    const synchronized = await waitFor(
      `http://127.0.0.1:${portB}/api/devbench/remote-config?projectId=project-a`,
      (result) => result.data?.vehicleMap?.avatr8678?.entries?.[0]?.branch === "release/manual-peer"
        && result.data?.sync?.connectedPeers === 1
        && result.data?.sync?.members?.some((member) => member.online),
      { timeout: 15_000, headers: { Authorization: `Bearer ${adminB.token}` } },
    );
    assert.equal(synchronized.data.sync.connectedPeers, 1);
    assert.ok(synchronized.data.sync.members.some((member) => member.online));
  } finally {
    await stopGateway(gatewayB);
    await stopGateway(gatewayA);
  }
});

test("预置签名引导节点无需用户输入或 peer 写请求即可跨子网自动入组", { timeout: 45_000 }, async () => {
  const portA = await freePort();
  const portB = await freePort();
  const discoveryPort = await freeUdpPort();
  const seedOrigin = `http://127.0.0.1:${portA}`;
  const envA = nodeEnvironment("rendezvous-node-a", portA, portB, {
    syncMode: "disabled",
    teamConfigSpace: "team/vehicle-source",
    discovery: true,
    discoveryPort,
  });
  const envB = nodeEnvironment("rendezvous-node-b", portB, portA, {
    syncMode: "disabled",
    teamConfigSpace: "team/vehicle-source",
    discovery: false,
    discoveryPort,
    discoverySeeds: [seedOrigin],
  });
  const adminA = await bootstrap(envA, seedOrigin);
  const adminB = await bootstrap(envB, `http://127.0.0.1:${portB}`);
  const gatewayA = startGateway(envA);
  let gatewayB = null;
  try {
    await waitFor(`${seedOrigin}/api/health`, (body) => body.status === "ok");
    await publish(
      portA,
      adminA.token,
      "release/rendezvous",
      "rendezvous-first-publish",
      "team/vehicle-source",
    );
    gatewayB = startGateway(envB);
    await waitFor(`http://127.0.0.1:${portB}/api/health`, (body) => body.status === "ok");

    const synchronized = await waitFor(
      `http://127.0.0.1:${portB}/api/devbench/remote-config?projectId=project-a`,
      (result) => result.data?.vehicleMap?.avatr8678?.entries?.[0]?.branch === "release/rendezvous"
        && result.data?.sync?.discoveryBootstrap?.status === "connected"
        && result.data?.sync?.discoveryBootstrap?.attemptedSeeds === 1,
      { timeout: 20_000, headers: { Authorization: `Bearer ${adminB.token}` } },
    );
    assert.equal(synchronized.data.sync.connectedPeers, 1);
    assert.deepEqual(synchronized.data.sync.discoveryBootstrap, {
      enabled: true,
      status: "connected",
      seedCount: 1,
      attemptedSeeds: 1,
      reachableSeeds: 1,
      joinedSeeds: 1,
      connectedSeeds: 1,
      lastAttemptAt: synchronized.data.sync.discoveryBootstrap.lastAttemptAt,
      lastSuccessAt: synchronized.data.sync.discoveryBootstrap.lastSuccessAt,
    });
    assert.ok(synchronized.data.sync.discoveryBootstrap.lastAttemptAt > 0);
    assert.ok(synchronized.data.sync.discoveryBootstrap.lastSuccessAt > 0);

    const peersResponse = await fetch(`http://127.0.0.1:${portB}/api/discovery/peers`, {
      headers: { Authorization: `Bearer ${adminB.token}` },
    });
    const peersBody = await peersResponse.json();
    assert.equal(peersResponse.status, 200, JSON.stringify(peersBody));
    assert.deepEqual(peersBody.data, [], "引导节点不能被静默提升为敏感 M2M trusted peer");

    await waitFor(
      `${seedOrigin}/api/devbench/remote-config?projectId=project-a`,
      (result) => result.data?.sync?.members?.some((member) => member.nodeName === "rendezvous-node-b"),
      { timeout: 5000, headers: { Authorization: `Bearer ${adminA.token}` } },
    );
  } finally {
    await stopGateway(gatewayB);
    await stopGateway(gatewayA);
  }
});
