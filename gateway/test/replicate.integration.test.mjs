/**
 * 服务端间共享配置复制 集成测试（gossip / 最终一致）：
 *   - srvA：共享配置版本高（含仓库"天气"）
 *   - srvB：空配置（版本 0）
 * 互为手动 peer。验证：B 自动从 A 拉取并应用共享配置（B 的仓库列表出现"天气"）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { bootGateway, waitHealth } from "./_helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbrepl-"));
const A = 39401, B = 39402, UDP = 48912;
const marketA = path.join(tmp, "marketA.json"), marketB = path.join(tmp, "marketB.json");
const PID = "project-ai-bootstrap";
const SHARED_VERSION = 9000000000000;

const importantMappings = {
  "important-old-key": { category: "vehicle", value: "important-vehicle" },
};
const compactedOps = [
  {
    id: `server-a:${SHARED_VERSION - 5000}:weather`,
    node: "server-a",
    version: SHARED_VERSION - 5000,
    at: SHARED_VERSION - 5000,
    type: "projectDef.set",
    value: { id: "weather", name: "天气", ssh: "git@h:x/W.git", https: "https://h/x/W" },
  },
  {
    id: `server-a:${SHARED_VERSION - 4999}:important-keyword`,
    node: "server-a",
    version: SHARED_VERSION - 4999,
    at: SHARED_VERSION - 4999,
    type: "byProject.set",
    projectId: PID,
    path: ["keywordMappings", "tag", "important-old-key"],
    value: importantMappings["important-old-key"],
  },
  ...Array.from({ length: 2105 }, (_, index) => ({
    id: `server-a:${SHARED_VERSION - 2105 + index}:filler-${index}`,
    node: "server-a",
    version: SHARED_VERSION - 2105 + index,
    at: SHARED_VERSION - 2105 + index,
    type: "byProject.set",
    projectId: PID,
    path: ["aiTraining", "configInference", "runs", `filler-run-${index}`],
    value: { id: `filler-run-${index}`, projectId: PID, updatedAt: SHARED_VERSION - 2105 + index },
  })),
];

// A：高版本 + 独有仓库"天气"
fs.writeFileSync(marketA, JSON.stringify({
  _sharedVersion: SHARED_VERSION,
  projectDefs: [{ id: "weather", name: "天气", ssh: "git@h:x/W.git", https: "https://h/x/W" }],
  byProject: {
    [PID]: {
      keywordMappings: { tag: importantMappings },
      aiTraining: {
        configInference: {
          runs: {
            "bootstrap-run": { id: "bootstrap-run", projectId: PID, ticket: { title: "跨设备启动样本" }, updatedAt: 200 },
          },
          samples: {
            "bootstrap-sample": { id: "bootstrap-sample", projectId: PID, source: "actual_execution", updatedAt: 220 },
          },
          trainedTickets: {
            "aaaaaaaaaaaaaaaaaaaaaaaa": { id: "aaaaaaaaaaaaaaaaaaaaaaaa", tbTaskId: "aaaaaaaaaaaaaaaaaaaaaaaa", sourceRunId: "bootstrap-run", trainedAt: 225, updatedAt: 225 },
          },
          trainingClaims: {
            "bbbbbbbbbbbbbbbbbbbbbbbb": { id: "bbbbbbbbbbbbbbbbbbbbbbbb", tbTaskId: "bbbbbbbbbbbbbbbbbbbbbbbb", sessionId: "bootstrap-session", claimedAt: Date.now(), expiresAt: Date.now() + 60 * 60 * 1000, createdAt: Date.now(), updatedAt: Date.now() },
          },
          settings: {
            taskSource: {
              type: "teambition_section",
              url: `https://www.teambition.com/project/${PID}/sprint/section/section-bootstrap`,
              projectId: PID,
              sectionId: "section-bootstrap",
              counts: { all: 8, pending: 3, completed: 5 },
            },
            updatedAt: 230,
          },
          tombstones: { runs: {}, samples: {}, trainedTickets: {}, trainingClaims: {} },
        },
      },
    },
  },
  sharedOps: compactedOps,
}));
fs.writeFileSync(marketB, JSON.stringify({})); // B 空，版本 0

const cfgA = path.join(tmp, "a.json"), cfgB = path.join(tmp, "b.json");
fs.writeFileSync(cfgA, JSON.stringify({ role: "standalone", claudeProxy: { enabled: true, token: "t", maxConcurrent: 3 }, lanSync: { syncMode: "peer", allowInsecureTransport: true, legacyCompatibility: true }, servers: { nodeName: "服务端A", discovery: true, discoveryPort: UDP, peers: [`http://localhost:${B}`] } }));
fs.writeFileSync(cfgB, JSON.stringify({ role: "standalone", claudeProxy: { enabled: true, token: "t", maxConcurrent: 3 }, lanSync: { syncMode: "peer", allowInsecureTransport: true, legacyCompatibility: true }, servers: { nodeName: "服务端B", discovery: true, discoveryPort: UDP, peers: [`http://localhost:${A}`] } }));

let srvA, srvB;
before(async () => {
  // 必须隔离 dbPath：共享配置(byProject/_sharedVersion)存 SQLite，不传则两端共用真实开发库 gateway/db/data.db，
  // gossip 无从复现、且会污染真实数据。
  srvA = bootGateway({ port: A, role: "standalone", gwCfg: cfgA, market: marketA, storeDir: path.join(tmp, "sa"), dbPath: path.join(tmp, "a.db"), allowDiscovery: true });
  srvB = bootGateway({ port: B, role: "standalone", gwCfg: cfgB, market: marketB, storeDir: path.join(tmp, "sb"), dbPath: path.join(tmp, "b.db"), allowDiscovery: true });
  await waitHealth(A, srvA); await waitHealth(B, srvB);
  await new Promise((r) => setTimeout(r, 11000));
}, { timeout: 60000 });
after(() => { try { srvA.kill(); } catch {} try { srvB.kill(); } catch {} });

test("B 自动从 A 复制共享配置（仓库出现'天气'）", async () => {
  const d = await fetch(`http://localhost:${B}/api/devbench/project-defs`).then((r) => r.json());
  assert.equal(d.ok, true);
  assert.ok(d.data.some((x) => x.name === "天气"), `B 应复制到 A 的仓库'天气'，实际: ${d.data.map((x) => x.name)}`);
});

test("A 仍持有自身共享配置", async () => {
  const d = await fetch(`http://localhost:${A}/api/devbench/project-defs`).then((r) => r.json());
  assert.ok(d.data.some((x) => x.name === "天气"));
});

test("A、B 的共享版本都进入来源配置的逻辑版本区间", async () => {
  const [a, b] = await Promise.all([
    fetch(`http://localhost:${A}/api/discovery/info`).then((r) => r.json()),
    fetch(`http://localhost:${B}/api/discovery/info`).then((r) => r.json()),
  ]);
  // sharedVersion 是各节点的本地单调写入水位，不是分布式状态哈希。节点接纳对端
  // 尚未见过的低版本、不同 key 操作时，可能各自在相邻版本上落盘；真正的收敛
  // 由逐 key clock、操作集合和下方“下一轮不再 bump”断言保证。
  assert.ok(a.data.sharedVersion >= SHARED_VERSION);
  assert.ok(b.data.sharedVersion >= SHARED_VERSION, "仓库推理画像迁移允许在初始共享版本上追加增量操作");
});

test("关键普通配置早于 2000 条训练窗口时仍保留，B 同时由快照完整 bootstrap AI 历史", async () => {
  const bundle = await fetch(`http://localhost:${A}/api/discovery/shared-bundle`).then((r) => r.json());
  assert.equal(bundle.ok, true);
  assert.ok(bundle.data.sharedOps.length > 2000, "普通配置的逐 key 最新操作应保留在最近训练窗口之外");
  assert.equal(bundle.data.sharedOps.some((op) => op.value?.id === "weather"), true);
  assert.equal(bundle.data.sharedOps.some((op) => op.path?.join("/") === "keywordMappings/tag/important-old-key"), true);
  assert.equal(bundle.data.sharedOps.some((op) => op.path?.at(-1) === "filler-run-0"), false, "最旧训练 filler 应被窗口裁掉");
  assert.equal(bundle.data.aiTrainingSnapshot.schemaVersion, 1);
  assert.equal(
    Object.hasOwn(
      bundle.data.aiTrainingSnapshot.byProject?.[PID]?.configInference?.runs || {},
      "bootstrap-run",
    ),
    true,
  );

  const learned = await fetch(`http://localhost:${B}/api/discovery/shared-bundle`).then((r) => r.json());
  assert.equal(learned.ok, true);
  const inference = learned.data.aiTrainingSnapshot.byProject?.[PID]?.configInference || {};
  assert.equal(Object.hasOwn(inference.runs || {}, "bootstrap-run"), true);
  assert.equal(Object.hasOwn(inference.samples || {}, "bootstrap-sample"), true);
  assert.equal(Object.hasOwn(inference.trainedTickets || {}, "aaaaaaaaaaaaaaaaaaaaaaaa"), true);
  assert.equal(
    inference.trainingClaims?.bbbbbbbbbbbbbbbbbbbbbbbb?.sessionId,
    "bootstrap-session",
  );
  assert.equal(inference.settings?.taskSource?.sectionId, "section-bootstrap");
  assert.deepEqual(inference.settings?.taskSource?.counts, { all: 8, pending: 3, completed: 5 });
  const mappings = await fetch(`http://localhost:${B}/api/devbench/keyword-mappings?projectId=${PID}`).then((r) => r.json());
  assert.deepEqual(mappings.data.tag["important-old-key"], importantMappings["important-old-key"]);
});

test("无用户写入的下一轮 reconcile 不重复接纳裁剪窗口旧 op，也不 bump sharedVersion", async () => {
  const beforeA = await fetch(`http://localhost:${A}/api/discovery/info`).then((r) => r.json());
  const beforeB = await fetch(`http://localhost:${B}/api/discovery/info`).then((r) => r.json());
  await new Promise((resolve) => setTimeout(resolve, 9000));
  const afterA = await fetch(`http://localhost:${A}/api/discovery/info`).then((r) => r.json());
  const afterB = await fetch(`http://localhost:${B}/api/discovery/info`).then((r) => r.json());
  assert.equal(afterA.data.sharedVersion, beforeA.data.sharedVersion);
  assert.equal(afterB.data.sharedVersion, beforeB.data.sharedVersion);
  // sharedVersion 是本地写入水位；内容已经收敛时不再为追平对端水位写 SQLite。
  // 两端版本允许不同，但后续空转 reconcile 必须各自保持稳定。
}, { timeout: 20000 });
