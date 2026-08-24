/**
 * 局域网中央转发 集成测试（模拟多台网关，无需多台物理机）：
 *   - server：standalone 角色，权威共享配置（仓库/车型/关键词）
 *   - node：node 角色，claudeProxyClient.host 指向 server
 *   - vehicle client：standalone 且关闭 AI 代理，只为车型配置显式连接 server
 *   - unreachable client：显式车型中心不可达，必须失败关闭
 * 验证：共享配置按目标转发；cloneParent 用客户端本机；env-check 始终本机；失败时不回退旧快照。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbfwd-"));
const SP = 39101, NP = 39102, VP = 39103, UP = 39104; // server / legacy node / standalone vehicle client / unreachable center client
const UNREACHABLE_CENTER_PORT = 39199;
const DEFAULT_PID = "65a5f274950780b816cf905e"; // 空 projects → 旧默认项目
const serverCloneParent = path.join(tmp, "server-clones");
const nodeCloneParent = path.join(tmp, "node-clones");

// server 的权威共享配置：独有仓库"天气-SERVER" + 车型 + 关键词 + cloneParent
const serverMarket = path.join(tmp, "server-market.json");
fs.writeFileSync(serverMarket, JSON.stringify({
  projects: [{ id: "server-local", name: "SERVER-LOCAL", path: "D:/SERVER-local" }],
  projectDefs: [{ id: "weather", name: "天气-SERVER", ssh: "git@h:x/Weather.git", https: "https://h/x/Weather" }],
  cloneParent: serverCloneParent,
  byProject: { [DEFAULT_PID]: {
    vehicleMap: { car8678: { apps: [{ appName: "App Market", repos: [{ repoId: "weather", branch: "v1", flavor: "car8678" }] }] } },
    keywordMappings: { tag: { 服务端标签: { category: "app", value: "FromServer" } } },
  } },
}));
const nodeMarket = path.join(tmp, "node-market.json");   // node 本机库：工程列表/cloneParent 必须走本机
fs.writeFileSync(nodeMarket, JSON.stringify({
  cloneParent: nodeCloneParent,
  projects: [{ id: "node-local", name: "NODE-LOCAL", path: "D:/NODE-local" }],
}));

const serverCfg = path.join(tmp, "server-cfg.json");
fs.writeFileSync(serverCfg, JSON.stringify({
  role: "standalone",
  servers: { discovery: false, inboundToken: "t" },
}));
const nodeCfg = path.join(tmp, "node-cfg.json");
fs.writeFileSync(nodeCfg, JSON.stringify({
  role: "node",
  servers: {
    discovery: false,
    peers: [`http://localhost:${SP}`],
    selectedHost: `http://localhost:${SP}`,
  },
  claudeProxyClient: { enabled: true, host: `http://localhost:${SP}`, token: "t" },
  // 此用例验证旧中心转发模式；syncMode=peer 的 node 已由 lan-sync 集成测试覆盖。
  lanSync: { syncMode: "disabled" },
}));
const vehicleClientCfg = path.join(tmp, "vehicle-client-cfg.json");
fs.writeFileSync(vehicleClientCfg, JSON.stringify({
  role: "standalone",
  servers: {
    discovery: false,
    peers: [`http://localhost:${SP}`],
  },
  claudeProxyClient: { enabled: false, host: "", token: "" },
  vehicleConfigCenter: {
    enabled: true,
    host: `http://localhost:${SP}`,
    token: "t",
  },
  lanSync: { syncMode: "disabled" },
}));
const unreachableVehicleClientCfg = path.join(tmp, "unreachable-vehicle-client-cfg.json");
fs.writeFileSync(unreachableVehicleClientCfg, JSON.stringify({
  role: "standalone",
  servers: {
    discovery: false,
    peers: [`http://localhost:${UNREACHABLE_CENTER_PORT}`],
  },
  vehicleConfigCenter: {
    enabled: true,
    host: `http://localhost:${UNREACHABLE_CENTER_PORT}`,
    token: "t",
  },
  lanSync: { syncMode: "disabled" },
}));

function boot(name, port, role, gwCfg, market) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: GW_DIR, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, NODE_ENV: "test", PORT: String(port), ROLE: role,
      DEVBENCH_GIT_CONTROLLER_ADAPTER: "in-process-test",
      GATEWAY_CONFIG_PATH: gwCfg, DEVBENCH_CONFIG_PATH: market,
      // 同一台测试机模拟两台设备时，本机工程列表/cloneParent 也必须各用一份本地文件。
      DEVBENCH_LOCAL_PROJECTS_PATH: path.join(tmp, `${name}-local-projects.json`),
      DEVBENCH_STORE_DIR: path.join(tmp, `${name}-store`),
      // 必须隔离 SQLite 库：byProject(车型/关键词/共享配置)存 SQLite，不隔离会读写真实开发库 gateway/db/data.db，
      // 既污染真实数据、又使 JSON 里的 fixture(byProject)被真实库覆盖而读不到 → 测试假性失败。
      GATEWAY_DB_PATH: path.join(tmp, `${name}.db`),
      CLOUD_URL: "http://127.0.0.1:1" /* 让 shared-config 同步快速失败，不影响 */ },
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  child.on("error", () => {});
  child._stderr = () => stderr;
  return child;
}

async function waitHealth(port, child, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://localhost:${port}/api/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`端口 ${port} 网关未就绪。stderr:\n${child._stderr().slice(-800)}`);
}
const get = (port, p) => fetch(`http://localhost:${port}/api/devbench${p}`).then((r) => r.json());
const post = (port, p, body) => fetch(`http://localhost:${port}/api/devbench${p}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body || {}),
}).then((r) => r.json());
const del = (port, p) => fetch(`http://localhost:${port}/api/devbench${p}`, { method: "DELETE" }).then((r) => r.json());

let server, node, vehicleClient, unreachableVehicleClient;
before(async () => {
  server = boot("server", SP, "standalone", serverCfg, serverMarket);
  node = boot("node", NP, "node", nodeCfg, nodeMarket);
  vehicleClient = boot("vehicle-client", VP, "standalone", vehicleClientCfg, nodeMarket);
  unreachableVehicleClient = boot("unreachable-vehicle-client", UP, "standalone", unreachableVehicleClientCfg, nodeMarket);
  await waitHealth(SP, server);
  await waitHealth(NP, node);
  await waitHealth(VP, vehicleClient);
  await waitHealth(UP, unreachableVehicleClient);
}, { timeout: 45000 });
after(() => {
  try { server.kill(); } catch {}
  try { node.kill(); } catch {}
  try { vehicleClient.kill(); } catch {}
  try { unreachableVehicleClient.kill(); } catch {}
});

test("node 读仓库定义 = server 的（转发，非本地种子）", async () => {
  const [nodeDefs, serverDefs] = await Promise.all([
    get(NP, "/project-defs"),
    get(SP, "/project-defs"),
  ]);
  assert.equal(nodeDefs.ok, true);
  assert.equal(serverDefs.ok, true);
  const names = nodeDefs.data.map((x) => x.name);
  assert.ok(names.includes("天气-SERVER"), `应含 server 独有仓库，实际: ${names}`);
  assert.deepEqual(
    nodeDefs.data.map((x) => x.id).sort(),
    serverDefs.data.map((x) => x.id).sort(),
    "node 应完整转发 server 当前仓库定义，包括自动补齐的推理画像",
  );
});

test("node 读车型映射 = server 的（转发）", async () => {
  const d = await get(NP, `/remote-config?projectId=${DEFAULT_PID}`);
  assert.equal(d.ok, true);
  assert.ok(d.data.vehicleMap.car8678, "应读到 server 的车型 car8678");
  assert.equal(d.data.vehicleMap.car8678.entries[0].projectId, "weather"); // 展平 entries 用 projectId(=repoId)
});

test("standalone 不启用 AI 代理也能从独立车型配置中心读取最新映射", async () => {
  const [d, defs] = await Promise.all([
    get(VP, `/remote-config?projectId=${DEFAULT_PID}`),
    get(VP, "/project-defs"),
  ]);
  assert.equal(d.ok, true);
  assert.ok(d.data.vehicleMap.car8678, "应读到 center 的车型 car8678");
  assert.ok(defs.data.some((definition) => definition.id === "weather"), "车型依赖的仓库定义也必须来自 center");
  assert.equal(d.data.sync.sourceMode, "center");
  assert.equal(d.data.sync.sourceHost, `http://localhost:${SP}`);
  assert.equal(d.data.sync.runtimeProfile, "production");
  assert.equal(d.data.sync.localSyncMode, "disabled");
});

test("显式车型配置中心不可达时失败关闭，不回退本机旧快照", async () => {
  const response = await fetch(`http://localhost:${UP}/api/devbench/remote-config?projectId=${DEFAULT_PID}`);
  const d = await response.json();
  assert.equal(response.status, 502);
  assert.equal(d.ok, false);
  assert.equal(d.code, "CENTER_M2M_FORWARD_FAILED");
});

test("node 的 cloneParent 用本机（不取 server 的）", async () => {
  const d = await get(NP, `/remote-config?projectId=${DEFAULT_PID}`);
  assert.equal(d.data.cloneParent, path.resolve(nodeCloneParent), "cloneParent 应是规范化后的 node 本机值");
  assert.notEqual(d.data.cloneParent, path.resolve(serverCloneParent), "cloneParent 不得取 server 值");
});

test("node 的工程列表用本机 projects，不转发也不读取 server", async () => {
  const nodeProjects = await get(NP, "/projects");
  assert.equal(nodeProjects.ok, true);
  assert.deepEqual(nodeProjects.data.map((p) => p.id), ["node-local"]);

  const serverProjects = await get(SP, "/projects");
  assert.equal(serverProjects.ok, true);
  assert.deepEqual(serverProjects.data.map((p) => p.id), ["server-local"]);
});

test("node 新增/删除工程只影响 node 本机工程列表", async () => {
  const add = await post(NP, "/projects", { id: "node-added", name: "NODE-ADDED", path: "D:/NODE-added" });
  assert.equal(add.ok, true);
  assert.ok((await get(NP, "/projects")).data.some((p) => p.id === "node-added"));
  assert.equal((await get(SP, "/projects")).data.some((p) => p.id === "node-added"), false);

  const removed = await del(NP, "/projects/node-added");
  assert.equal(removed.ok, true);
  assert.equal((await get(NP, "/projects")).data.some((p) => p.id === "node-added"), false);
  assert.deepEqual((await get(SP, "/projects")).data.map((p) => p.id), ["server-local"]);
});

test("node 读关键词映射 = server 的（转发）", async () => {
  const d = await get(NP, `/keyword-mappings?projectId=${DEFAULT_PID}`);
  assert.equal(d.ok, true);
  assert.equal(d.data.tag["服务端标签"].value, "FromServer");
});

test("env-check 始终本机执行（node 自己的环境）", async () => {
  const d = await get(NP, "/env-check");
  assert.equal(d.ok, true);
  assert.ok(Array.isArray(d.data.results));
  assert.ok(d.data.results.find((t) => t.key === "git"), "应有 git 检测项");
});

test("server 自身权威（standalone 不转发，直读本地）", async () => {
  const d = await get(SP, "/project-defs");
  assert.ok(d.data.some((x) => x.name === "天气-SERVER"));
});
