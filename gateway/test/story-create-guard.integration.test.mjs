import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { bootGateway, waitHealth } from "./_helpers.mjs";

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "story-create-guard-"));
const productionPort = 39947;
const isolatedTestPort = 39948;
const processes = [];

function runtime(name) {
  const root = path.join(runtimeRoot, name);
  fs.mkdirSync(root, { recursive: true });
  const gatewayConfig = path.join(root, "gateway.json");
  const marketConfig = path.join(root, "market.json");
  fs.writeFileSync(gatewayConfig, JSON.stringify({ role: "standalone" }), "utf8");
  fs.writeFileSync(marketConfig, JSON.stringify({ projects: [], byProject: {} }), "utf8");
  return {
    root,
    gatewayConfig,
    marketConfig,
    storeDir: path.join(root, "store"),
    dbPath: path.join(root, "gateway.db"),
  };
}

async function postStory(port, title, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api/devbench/tabs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ title }),
  });
  return { response, body: await response.json() };
}

before(async () => {
  const production = runtime("production");
  const productionGateway = bootGateway({
    port: productionPort,
    gwCfg: production.gatewayConfig,
    market: production.marketConfig,
    storeDir: production.storeDir,
    dbPath: production.dbPath,
    extraEnv: { NODE_ENV: "production" },
  });
  processes.push(productionGateway);
  await waitHealth(productionPort, productionGateway);

  const isolated = runtime("isolated-test");
  const isolatedGateway = bootGateway({
    port: isolatedTestPort,
    gwCfg: isolated.gatewayConfig,
    market: isolated.marketConfig,
    storeDir: isolated.storeDir,
    dbPath: isolated.dbPath,
    extraEnv: { NODE_ENV: "test" },
  });
  processes.push(isolatedGateway);
  await waitHealth(isolatedTestPort, isolatedGateway);
}, { timeout: 60000 });

after(() => {
  for (const child of processes) {
    try { child.kill(); } catch {}
  }
});

test("production Gateway 拒绝 E2E 和未确认直写，只有初始化确认后才创建并写审计日志", async () => {
  const blocked = await postStory(productionPort, "E2E e2e-1785407076148-h5q2");
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.body.code, "E2E_STORY_REQUIRES_ISOLATED_RUNTIME");

  const afterBlocked = await fetch(`http://127.0.0.1:${productionPort}/api/devbench/tabs`).then((response) => response.json());
  assert.deepEqual(afterBlocked.data, []);

  const direct = await postStory(productionPort, "avatr8678国家码问题", {
    "X-Request-Id": "normal-story-1",
    "X-Devbench-Request-Source": "story-entry",
  });
  assert.equal(direct.response.status, 409);
  assert.equal(direct.body.code, "STORY_INITIALIZATION_CONFIRMATION_REQUIRED");

  const beforeConfirmed = await fetch(`http://127.0.0.1:${productionPort}/api/devbench/tabs`).then((response) => response.json());
  assert.deepEqual(beforeConfirmed.data, [], "未确认初始化时不得创建 Tab");
  const preparedResponse = await fetch(`http://127.0.0.1:${productionPort}/api/devbench/story-initializations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "avatr8678国家码问题",
      sourceLabel: "集成测试人工确认",
      configuration: { mode: "blank" },
    }),
  });
  const prepared = await preparedResponse.json();
  assert.equal(preparedResponse.status, 201, prepared.error);
  const createdResponse = await fetch(`http://127.0.0.1:${productionPort}/api/devbench/tabs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": "normal-story-1",
      "X-Devbench-Request-Source": "story-entry",
    },
    body: JSON.stringify({ initializationIntentId: prepared.data.id }),
  });
  const created = { response: createdResponse, body: await createdResponse.json() };
  assert.equal(created.response.status, 200);
  assert.equal(created.body.ok, true);

  const replayResponse = await fetch(`http://127.0.0.1:${productionPort}/api/devbench/tabs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initializationIntentId: prepared.data.id }),
  });
  const replay = await replayResponse.json();
  assert.equal(replayResponse.status, 200, replay.error);
  assert.equal(replay.ok, true);
  assert.equal(replay.data.id, created.body.data.id, "同一确认意图重放必须幂等返回首次创建结果");
  const afterReplay = await fetch(`http://127.0.0.1:${productionPort}/api/devbench/tabs`).then((response) => response.json());
  assert.equal(afterReplay.data.length, 1, "确认意图重放不得重复创建 Tab");

  const logs = await fetch(`http://127.0.0.1:${productionPort}/api/logs/search?keyword=normal-story-1&limit=20`)
    .then((response) => response.json());
  assert.equal(logs.success, true);
  assert.equal(logs.data.some((row) => row.module === "devbench-create"
    && row.message.includes(created.body.data.id)
    && row.message.includes("source=story-entry")), true);
});

test("同一 Gateway 的两个已签 intent 并发创建同一显式 URL 时只允许一个落盘", async () => {
  const ticketBase = "https://tickets.example.test/work-items/atomic-create-17003";
  const prepare = async (title, fragment) => {
    const response = await fetch(`http://127.0.0.1:${productionPort}/api/devbench/story-initializations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        ticketInput: `${ticketBase}#${fragment}`,
        configuration: { mode: "blank" },
        entry: { kind: "blank_story" },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 201, body.error);
    return body.data.id;
  };
  const [leftIntent, rightIntent] = await Promise.all([
    prepare("显式 URL 并发创建-左", "left"),
    prepare("显式 URL 并发创建-右", "right"),
  ]);
  const create = async (initializationIntentId) => {
    const response = await fetch(`http://127.0.0.1:${productionPort}/api/devbench/tabs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initializationIntentId }),
    });
    return { response, body: await response.json(), initializationIntentId };
  };
  const outcomes = await Promise.all([create(leftIntent), create(rightIntent)]);
  const succeeded = outcomes.filter((item) => item.response.status === 200 && item.body.ok === true);
  const rejected = outcomes.filter((item) => item.response.status === 409 && item.body.code === "STORY_TICKET_TAKEN");
  assert.equal(succeeded.length, 1, JSON.stringify(outcomes.map((item) => ({ status: item.response.status, body: item.body }))));
  assert.equal(rejected.length, 1, JSON.stringify(outcomes.map((item) => ({ status: item.response.status, body: item.body }))));

  const tabs = await fetch(`http://127.0.0.1:${productionPort}/api/devbench/tabs`).then((response) => response.json());
  const bound = tabs.data.filter((tab) => String(tab.ticketUrl || "").startsWith(ticketBase));
  assert.equal(bound.length, 1, "等价显式 URL 最终只能绑定一条故事点");
  assert.equal(Object.hasOwn(bound[0], "ticketIdentity"), false, "不得持久化 URL hash");
  assert.equal(Object.hasOwn(bound[0], "ticketIdentities"), false, "不得持久化 URL hash 集合");

  const retry = await create(rejected[0].initializationIntentId);
  assert.equal(retry.response.status, 409, retry.body.error);
  assert.equal(retry.body.code, "STORY_TICKET_TAKEN", "原子拒绝后 intent 必须释放并允许重新执行权威检查");
});

test("初始化 intent 绑定创建入口，失败请求释放租约后仍可安全重试", async () => {
  const crossEntryResponse = await fetch(`http://127.0.0.1:${productionPort}/api/devbench/story-initializations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Git purpose intent",
      configuration: { mode: "blank" },
      entry: { kind: "git_commit", repositoryId: "repo", revision: "abc" },
    }),
  });
  const crossEntry = await crossEntryResponse.json();
  assert.equal(crossEntryResponse.status, 201, crossEntry.error);
  const crossUseResponse = await fetch(`http://127.0.0.1:${productionPort}/api/devbench/tabs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initializationIntentId: crossEntry.data.id }),
  });
  const crossUse = await crossUseResponse.json();
  assert.equal(crossUseResponse.status, 409);
  assert.equal(crossUse.code, "STORY_INITIALIZATION_CONSUMER_MISMATCH");

  const e2eTitle = "E2E e2e-1785407076149-rty7";
  const preparedResponse = await fetch(`http://127.0.0.1:${productionPort}/api/devbench/story-initializations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: e2eTitle, configuration: { mode: "blank" } }),
  });
  const prepared = await preparedResponse.json();
  assert.equal(preparedResponse.status, 201, prepared.error);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${productionPort}/api/devbench/tabs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initializationIntentId: prepared.data.id }),
    });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.code, "E2E_STORY_REQUIRES_ISOLATED_RUNTIME", "失败后 intent 应释放，而不是停留在处理中");
  }
});

test("完全隔离的 test Gateway 允许 E2E 标题", async () => {
  const created = await postStory(isolatedTestPort, "E2E e2e-1785407076148-h5q2", {
    "X-Devbench-E2E-Run": "guard-integration",
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.ok, true);
  assert.equal(created.body.data.title, "E2E e2e-1785407076148-h5q2");
});
