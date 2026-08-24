import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";
import { VisualOperationGuard, stableHash } from "../../tools/visual-operation-guard/src/index.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dashboardRoot = path.join(repositoryRoot, "web-dashboard");
const policy = JSON.parse(fs.readFileSync(path.join(repositoryRoot, ".ai/visual-operation-guard/policy.json"), "utf8"));

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
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
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
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function createIsolatedGateway() {
  let definitions = [
    { id: "app-market", name: "应用市场", ssh: "git@example.test:app-market.git", projectType: "application" },
    { id: "app-market-web", name: "WebApp", ssh: "git@example.test:app-market-web.git", projectType: "application" },
  ];
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
      json(res, 200, { ok: true, data: { id: "isolated-admin", name: "隔离验收管理员", role: "admin", permissions: ["*"] } });
      return;
    }
    if (requestUrl.pathname === "/api/devbench/project-defs" && req.method === "GET") {
      json(res, 200, { ok: true, data: definitions });
      return;
    }
    if (requestUrl.pathname === "/api/devbench/project-defs" && req.method === "PUT") {
      writes.push({ method: req.method, path: requestUrl.pathname, body });
      definitions = definitions.map((definition) => definition.id === body?.id ? { ...body } : definition);
      json(res, 200, { ok: true, data: body });
      return;
    }
    if (req.method === "GET") {
      json(res, 200, { ok: true, data: [] });
      return;
    }
    unexpectedWrites.push({ method: req.method, path: requestUrl.pathname, body });
    json(res, 409, { ok: false, error: "隔离 UI 验收禁止此写请求" });
  });
  return { server, writes, unexpectedWrites };
}

test("隔离 DOM：工程配置真实创建固定兄弟目录 Bundle payload", { timeout: 120_000 }, async (t) => {
  const executablePath = browserExecutable();
  assert.ok(executablePath, "未找到可用于隔离 UI 验收的 Edge/Chrome");
  const mock = createIsolatedGateway();
  await new Promise((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
  const gatewayPort = mock.server.address().port;
  const uiPort = await freePort();
  const viteEntry = path.join(dashboardRoot, "node_modules/vite/bin/vite.js");
  const vite = spawn(process.execPath, [viteEntry, "--host", "127.0.0.1", "--port", String(uiPort), "--strictPort"], {
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
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.evaluateOnNewDocument((origin) => {
    localStorage.setItem("admin_token", "isolated-ui-token");
    localStorage.setItem("admin_token_audience", origin);
  }, baseUrl);

  const guard = new VisualOperationGuard(policy, {
    taskId: "storydev-workspace-bundle-rule-1-ui",
    mode: "acceptance",
  });
  const preflight = guard.preflight({
    targetState: "隔离 DevBench 工程配置保存固定兄弟目录 Bundle",
    successCriteria: [
      "真实 DOM 点击和输入生成两个成员",
      "保存 payload 固定为 SAME_PARENT_SIBLINGS 与 SAME_LOGICAL_BRANCH",
      "构建入口可修改且 WebApp 为必需只读依赖",
      "除 project-defs 外没有写请求",
    ],
    estimatedScreenTransitions: 2,
    estimatedVisualActions: 0,
    coreInteractionUnderTest: "打开工程配置、启用 Bundle、填写两个固定目录并保存",
    chosenChannel: "playwright",
    alternatives: {
      structured_integration: { status: "available", channelsChecked: ["api"], strategyId: "isolated-api-arrange-assert", reason: "API 仅用于隔离 Arrange 与 payload Assert，不能替代核心 UI 交互" },
      command_or_config: { status: "available", channelsChecked: ["cli", "environment"], strategyId: "isolated-vite", reason: "隔离 Vite 和 mock Gateway 已启动" },
      direct_navigation: { status: "available", channelsChecked: ["route"], strategyId: "devbench-route", reason: "可直接进入 /devbench" },
      structured_ui: { status: "available", channelsChecked: ["playwright"], strategyId: "workspace-bundle-stable-testids", reason: "新增稳定 data-testid 可执行真实 DOM 交互" },
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
      guard.recordResult({ authorizationId: authorization.authorizationId, success: false, progress: false, checkpoint, error: error?.message || String(error) });
      throw error;
    }
  };
  const replaceInput = async (selector, value) => {
    await page.focus(selector);
    await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
    await page.keyboard.press("A");
    await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
    await page.keyboard.type(value);
  };

  await page.goto(`${baseUrl}/devbench`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector('[data-testid="project-config-trigger"]', { visible: true });
  await guardedAction("project-config-trigger", () => page.click('[data-testid="project-config-trigger"]'), "工程配置弹窗已打开");
  await page.waitForSelector('[data-testid="project-config-modal"]', { visible: true });
  await guardedAction("project-config-tab-defs", () => page.click('[data-testid="project-config-tab-defs"]'), "仓库定义 Tab 已打开");
  await page.waitForSelector('[data-testid="workspace-bundle-enabled"]:not([disabled])', { visible: true });
  await guardedAction("workspace-bundle-enabled", () => page.click('[data-testid="workspace-bundle-enabled"]'), "Bundle V2 已启用");
  await page.waitForSelector('[data-testid="workspace-bundle-member-directory-0"]', { visible: true });
  await guardedAction("workspace-bundle-member-directory-0", () => replaceInput('[data-testid="workspace-bundle-member-directory-0"]', "AppMarket"), "构建入口固定目录已填写");
  await guardedAction("workspace-bundle-add-member", () => page.click('[data-testid="workspace-bundle-add-member"]'), "依赖成员已添加");
  await page.waitForSelector('[data-testid="workspace-bundle-member-directory-1"]', { visible: true });
  await guardedAction("workspace-bundle-member-repository-1", async () => {
    await page.select('[data-testid="workspace-bundle-member-repository-1"]', "app-market-web");
  }, "依赖仓库已选为 WebApp");
  await guardedAction("workspace-bundle-member-directory-1", () => replaceInput('[data-testid="workspace-bundle-member-directory-1"]', "AppMarketWeb"), "依赖固定目录已填写");
  await guardedAction("save-project-definition-app-market", () => page.click('[data-testid="save-project-definition-app-market"]'), "Bundle 配置保存请求已发出");

  const deadline = Date.now() + 5000;
  while (!mock.writes.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(mock.writes.length, 1);
  assert.deepEqual(mock.unexpectedWrites, []);
  const payload = mock.writes[0].body;
  assert.equal(payload.id, "app-market");
  assert.deepEqual(payload.workspaceBundle, {
    version: 2,
    enabled: true,
    id: "app-market-bundle",
    buildEntryRepositoryId: "app-market",
    layoutPolicy: "SAME_PARENT_SIBLINGS",
    branchPolicy: "SAME_LOGICAL_BRANCH",
    strictBranch: true,
    members: [
      { repositoryId: "app-market", checkoutDirName: "AppMarket", required: true, mode: "EDITABLE" },
      { repositoryId: "app-market-web", checkoutDirName: "AppMarketWeb", required: true, mode: "READ_ONLY" },
    ],
  });
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  assert.equal(audit.length, 8);
  assert.equal(audit.every((entry) => entry.visualCostUnits === 0), true);
  assert.equal(guard.snapshot().counters.screenshots || 0, 0);
  t.diagnostic(`Visual Operation Guard: progress=true checkpoints=${audit.length} finalFingerprint=${audit.at(-1).fingerprint} screenshots=0 coordinateActions=0 visualCostUnits=0`);
});
