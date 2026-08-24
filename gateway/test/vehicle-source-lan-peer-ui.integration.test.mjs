import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";
import { VisualOperationGuard, stableHash } from "../../tools/visual-operation-guard/src/index.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dashboardRoot = path.join(repositoryRoot, "web-dashboard");
const policy = JSON.parse(fs.readFileSync(
  path.join(repositoryRoot, ".ai/visual-operation-guard/policy.json"),
  "utf8",
));

function browserExecutable() {
  const candidates = process.platform === "win32"
    ? [
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    ]
    : process.platform === "darwin"
      ? [
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ]
      : ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHttp(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`隔离 Vite 提前退出：${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("隔离 Vite 启动超时");
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("close", resolve);
      killer.once("error", resolve);
    });
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function createIsolatedGateway() {
  let connected = false;
  let remoteConfigReads = 0;
  const writes = [];
  const unexpectedWrites = [];
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try { body = rawBody ? JSON.parse(rawBody) : null; } catch {}

    if (requestUrl.pathname === "/api/admin/auth/me") {
      json(res, 200, {
        ok: true,
        data: { id: "isolated-admin", name: "隔离验收管理员", role: "admin", permissions: ["*"] },
      });
      return;
    }
    if (requestUrl.pathname === "/api/devbench/remote-config" && req.method === "GET") {
      remoteConfigReads += 1;
      json(res, 200, {
        ok: true,
        data: {
          projectId: "",
          revision: connected ? "2" : "1",
          projectDefs: [{ id: "appMarket", name: "应用市场", projectType: "application" }],
          remotes: {},
          cloneParent: "",
          defaultCloneParent: "C:\\workspace",
          vehicleMap: connected ? {
            geelyp162: {
              apps: [{
                appName: "应用市场",
                repos: [{ repoId: "appMarket", branch: "release/geelyp162", flavor: "geelyp162" }],
              }],
            },
          } : {},
          sync: {
            runtimeProfile: "test",
            teamConfigSpace: "team/vehicle-source",
            syncMode: "peer",
            sourceMode: "local",
            nodeId: "isolated-local",
            nodeName: "isolated-local",
            revision: connected ? "2" : "1",
            connectedPeers: connected ? 1 : 0,
            discoveryBootstrap: {
              enabled: true,
              status: connected ? "connected" : "retrying",
              seedCount: 1,
              attemptedSeeds: 1,
              reachableSeeds: connected ? 1 : 0,
              joinedSeeds: connected ? 1 : 0,
              connectedSeeds: connected ? 1 : 0,
            },
            members: connected ? [{
              nodeId: "isolated-remote",
              nodeName: "remote-admin-gateway",
              state: "active",
              host: "http://192.168.10.110:3001",
              online: true,
              lastSeenAt: Date.now(),
            }] : [],
            conflicts: 0,
          },
        },
      });
      return;
    }
    if (requestUrl.pathname === "/api/discovery/peers" && req.method === "POST") {
      writes.push({
        method: req.method,
        path: requestUrl.pathname,
        authorization: req.headers.authorization || "",
        body,
      });
      connected = true;
      json(res, 200, {
        ok: true,
        data: [body?.host],
        meta: {
          probe: {
            reachable: true,
            joined: true,
            reason: "joined",
            nodeId: "isolated-remote",
            nodeName: "remote-admin-gateway",
            reciprocalAnnounced: true,
          },
        },
      });
      return;
    }
    if (req.method === "GET") {
      json(res, 200, { ok: true, data: [] });
      return;
    }
    unexpectedWrites.push({ method: req.method, path: requestUrl.pathname, body });
    json(res, 409, { ok: false, error: "隔离 UI 验收禁止此写请求" });
  });
  return { server, writes, unexpectedWrites, remoteConfigReadCount: () => remoteConfigReads };
}

test("隔离 DOM：车型源码配置默认零输入组网并保留管理员高级恢复", { timeout: 120_000 }, async (t) => {
  const executablePath = browserExecutable();
  assert.ok(executablePath, "未找到可用于隔离 UI 验收的 Edge/Chrome");
  const mock = createIsolatedGateway();
  await new Promise((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
  const gatewayPort = mock.server.address().port;
  const uiPort = await freePort();
  const viteEntry = path.join(dashboardRoot, "node_modules/vite/bin/vite.js");
  const vite = spawn(process.execPath, [
    viteEntry,
    "--host", "127.0.0.1",
    "--port", String(uiPort),
    "--strictPort",
  ], {
    cwd: dashboardRoot,
    env: { ...process.env, VITE_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}` },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let viteOutput = "";
  vite.stdout?.on("data", (chunk) => { viteOutput = `${viteOutput}${chunk}`.slice(-12_000); });
  vite.stderr?.on("data", (chunk) => { viteOutput = `${viteOutput}${chunk}`.slice(-12_000); });
  let browser = null;
  t.after(async () => {
    try { await browser?.close(); } catch {}
    await stopProcess(vite);
    await new Promise((resolve) => mock.server.close(resolve));
  });

  const baseUrl = `http://127.0.0.1:${uiPort}`;
  await waitForHttp(`${baseUrl}/devbench`, vite).catch((error) => {
    throw new Error(`${error.message}\n${viteOutput}`);
  });
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  const remoteBrowserRequests = [];
  const discoveryBrowserRequests = [];
  const failedBrowserRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (request.url().startsWith("http://192.168.10.110:3001")) remoteBrowserRequests.push(request.url());
    if (request.url().includes("/api/discovery/peers")) discoveryBrowserRequests.push(request.url());
  });
  page.on("requestfailed", (request) => failedBrowserRequests.push({
    url: request.url(),
    error: request.failure()?.errorText || "",
  }));
  await page.evaluateOnNewDocument((origin) => {
    localStorage.setItem("admin_token", "isolated-ui-token");
    localStorage.setItem("admin_token_audience", origin);
  }, baseUrl);

  const guard = new VisualOperationGuard(policy, {
    taskId: "devbench-lan-vehicle-source-sync-ui",
    mode: "balanced",
  });
  const preflight = guard.preflight({
    targetState: "隔离 DevBench 车型源码配置默认展示自动组网，并可展开管理员高级恢复",
    successCriteria: [
      "默认只展示后台自动组网状态，不要求用户填写 Gateway",
      "真实 DOM 输入和点击提交准确 origin",
      "请求只发往当前 Gateway 并携带当前管理员凭据",
      "连接后刷新为在线成员并出现远端车型",
      "隔离验收除 discovery/peers 外没有写请求",
    ],
    estimatedScreenTransitions: 2,
    estimatedVisualActions: 0,
    coreInteractionUnderTest: "打开车型源码配置、确认默认零输入状态，再展开高级恢复并登记 origin",
    chosenChannel: "playwright",
    alternatives: {
      structured_integration: { status: "available", channelsChecked: ["api"], strategyId: "isolated-api-arrange-assert", reason: "API 只准备隔离状态并断言 payload，不能代替点击" },
      command_or_config: { status: "available", channelsChecked: ["cli", "environment"], strategyId: "isolated-vite", reason: "隔离 Vite 与 mock Gateway 可用" },
      direct_navigation: { status: "available", channelsChecked: ["route"], strategyId: "devbench-route", reason: "可直接进入 /devbench" },
      structured_ui: { status: "available", channelsChecked: ["playwright"], strategyId: "vehicle-lan-peer-testids", reason: "稳定 data-testid 可完成真实 DOM 交互" },
    },
  });
  assert.equal(preflight.allowed, true, preflight.code);
  const audit = [];
  const guardedAction = async (targetId, action, checkpoint) => {
    const authorization = guard.authorize({
      toolName: "playwright.dom-action",
      channel: "playwright",
      operationType: "structured_ui",
      coordinateBased: false,
      targetId,
    });
    assert.equal(authorization.allowed, true, `${targetId}: ${authorization.code}`);
    const started = guard.beginExecution({ authorizationId: authorization.authorizationId });
    assert.equal(started.code, "EXECUTION_STARTED");
    try {
      await action();
      const fingerprint = stableHash(await page.$eval("body", (element) => element.innerText.slice(0, 20_000)));
      const recorded = guard.recordResult({
        authorizationId: authorization.authorizationId,
        success: true,
        progress: true,
        screenFingerprint: fingerprint,
        checkpoint,
        usage: { screenshots: 0, coordinateActions: 0 },
      });
      assert.equal(recorded.code, "RESULT_RECORDED");
      audit.push({ targetId, checkpoint, fingerprint, visualCostUnits: authorization.visualCostUnits || 0 });
    } catch (error) {
      guard.recordResult({
        authorizationId: authorization.authorizationId,
        success: false,
        progress: false,
        checkpoint,
        error: error?.message || String(error),
      });
      throw error;
    }
  };

  await page.goto(`${baseUrl}/devbench`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector('[data-testid="project-config-trigger"]', { visible: true });
  await guardedAction(
    "project-config-trigger",
    () => page.click('[data-testid="project-config-trigger"]'),
    "工程配置弹窗已打开",
  );
  await page.waitForSelector('[data-testid="project-config-tab-vehicle"]', { visible: true });
  await guardedAction(
    "project-config-tab-vehicle",
    () => page.click('[data-testid="project-config-tab-vehicle"]'),
    "车型源码配置 Tab 已打开",
  );
  await page.waitForSelector('[data-testid="vehicle-lan-auto-discovery"]', { visible: true });
  const automaticText = await page.$eval('[data-testid="vehicle-lan-auto-discovery"]', (element) => element.innerText);
  assert.match(automaticText, /跨子网自动发现重试中/);
  assert.match(automaticText, /无需用户操作/);
  assert.deepEqual(await page.$eval('[data-testid="vehicle-lan-peer-recovery"]', (details) => ({
    open: details.open,
    inputVisible: details.querySelector('[data-testid="vehicle-lan-peer-origin"]')?.checkVisibility?.() === true,
  })), { open: false, inputVisible: false }, "高级恢复输入默认必须折叠");
  await guardedAction(
    "vehicle-lan-peer-recovery",
    () => page.click('[data-testid="vehicle-lan-peer-recovery"] > summary'),
    "管理员高级恢复已展开",
  );
  await page.waitForSelector('[data-testid="vehicle-lan-peer-origin"]', { visible: true });
  await guardedAction("vehicle-lan-peer-origin", async () => {
    await page.type('[data-testid="vehicle-lan-peer-origin"]', "http://192.168.10.110:3001");
  }, "跨子网 Gateway origin 已填写");
  assert.equal(await page.$eval('[data-testid="vehicle-lan-peer-origin"]', (element) => element.value), "http://192.168.10.110:3001");
  assert.equal(await page.$eval('[data-testid="vehicle-lan-peer-connect-submit"]', (element) => element.disabled), false);
  await guardedAction(
    "vehicle-lan-peer-connect-submit",
    async () => {
      const hitTarget = await page.$eval('[data-testid="vehicle-lan-peer-connect-submit"]', (element) => {
        element.scrollIntoView({ block: "center" });
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + (rect.width / 2), rect.top + (rect.height / 2));
        return {
          target: element.getAttribute("data-testid"),
          hit: hit?.getAttribute?.("data-testid") || hit?.tagName || "",
          contains: element === hit || element.contains(hit),
        };
      });
      assert.equal(hitTarget.contains, true, JSON.stringify(hitTarget));
      await page.click('[data-testid="vehicle-lan-peer-connect-submit"]');
    },
    "连接并同步请求已提交",
  );

  const writeDeadline = Date.now() + 5000;
  while (!mock.writes.length && Date.now() < writeDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const peerRegionText = await page.$eval('[data-testid="vehicle-lan-peer-connect"]', (element) => element.innerText);
  assert.equal(mock.writes.length, 1, `真实 DOM 点击必须提交 discovery/peers; browserRequests=${JSON.stringify(discoveryBrowserRequests)}; failed=${JSON.stringify(failedBrowserRequests)}; region=${peerRegionText}`);

  await page.waitForFunction(
    () => document.body.innerText.includes("已连接 remote-admin-gateway，车型配置已刷新。"),
    { timeout: 10_000 },
  ).catch(async (error) => {
    const pageText = await page.$eval("body", (element) => element.innerText.slice(-4000));
    throw new Error(`${error.message}; writes=${JSON.stringify(mock.writes.map((row) => ({ method: row.method, path: row.path, body: row.body })))}; page=${pageText}`);
  });
  await page.waitForFunction(() => document.body.innerText.includes("geelyp162"));
  assert.deepEqual(mock.writes, [{
    method: "POST",
    path: "/api/discovery/peers",
    authorization: "Bearer isolated-ui-token",
    body: { host: "http://192.168.10.110:3001" },
  }]);
  assert.deepEqual(mock.unexpectedWrites, []);
  assert.equal(mock.remoteConfigReadCount() >= 2, true);
  assert.deepEqual(remoteBrowserRequests, []);
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  assert.equal(audit.length, 5);
  assert.equal(audit.every((entry) => entry.visualCostUnits === 0), true);
  assert.equal(guard.snapshot().counters.screenshots || 0, 0);
  t.diagnostic(`Visual Operation Guard: progress=true checkpoints=${audit.length} finalFingerprint=${audit.at(-1).fingerprint} screenshots=0 coordinateActions=0 visualCostUnits=0`);
});
