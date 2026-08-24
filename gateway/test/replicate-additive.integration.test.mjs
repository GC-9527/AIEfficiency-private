/**
 * 两台独立 SQLite 节点同时学习同一仓库/车型的不同配置后，AI 配置写回使用
 * additive merge，在双向 gossip 后必须保留双方 branch、flavor 和 repo tuple。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { bootGateway, waitHealth } from "./_helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbrepl-additive-"));
const A = 39411, B = 39412, UDP = 48913;
const PID = "project-additive-convergence";
const REPO = "shared-market";
const VEHICLE = "shared-car";
const VERSION = 9100000000000;
const MERGE_STRATEGY = "config_inference_additive";

function projectDef(branch, flavor) {
  return {
    id: REPO,
    name: "共享应用市场",
    https: "https://example.com/shared-market.git",
    inferenceEnabled: true,
    branchOptions: ["base", branch],
    flavorOptions: ["base", flavor],
  };
}

function vehicleMapping(branch, flavor) {
  return {
    aliases: [flavor],
    apps: [{
      appName: "应用市场",
      repos: [{ repoId: REPO, branch, flavor, targetRole: "primary", order: 1 }],
    }],
  };
}

function sharedConfig(node, branch, flavor) {
  const def = projectDef(branch, flavor);
  const mapping = vehicleMapping(branch, flavor);
  return {
    _sharedVersion: VERSION,
    repositoryInferenceProfilesVersion: 1,
    projectDefs: [def],
    byProject: { [PID]: { vehicleMap: { [VEHICLE]: mapping } } },
    sharedOps: [
      {
        id: `${node}:${VERSION}:project-def`, node, version: VERSION, at: VERSION,
        type: "projectDef.set", value: def, mergeStrategy: MERGE_STRATEGY,
      },
      {
        id: `${node}:${VERSION}:vehicle-map`, node, version: VERSION, at: VERSION,
        type: "byProject.set", projectId: PID, path: ["vehicleMap", VEHICLE],
        value: mapping, mergeStrategy: MERGE_STRATEGY,
      },
    ],
  };
}

const marketA = path.join(tmp, "marketA.json");
const marketB = path.join(tmp, "marketB.json");
const cfgA = path.join(tmp, "gatewayA.json");
const cfgB = path.join(tmp, "gatewayB.json");
fs.writeFileSync(marketA, JSON.stringify(sharedConfig("node-a", "branch-a", "flavor-a")));
fs.writeFileSync(marketB, JSON.stringify(sharedConfig("node-b", "branch-b", "flavor-b")));
fs.writeFileSync(cfgA, JSON.stringify({
  role: "standalone",
  claudeProxy: { enabled: true, token: "t", maxConcurrent: 3 },
  lanSync: { syncMode: "peer", allowInsecureTransport: true, legacyCompatibility: true },
  servers: { nodeName: "增量节点A", discovery: true, discoveryPort: UDP, peers: [`http://localhost:${B}`] },
}));
fs.writeFileSync(cfgB, JSON.stringify({
  role: "standalone",
  claudeProxy: { enabled: true, token: "t", maxConcurrent: 3 },
  lanSync: { syncMode: "peer", allowInsecureTransport: true, legacyCompatibility: true },
  servers: { nodeName: "增量节点B", discovery: true, discoveryPort: UDP, peers: [`http://localhost:${A}`] },
}));

let srvA, srvB;
before(async () => {
  srvA = bootGateway({
    port: A, role: "standalone", gwCfg: cfgA, market: marketA,
    storeDir: path.join(tmp, "store-a"), dbPath: path.join(tmp, "node-a.db"), allowDiscovery: true,
  });
  srvB = bootGateway({
    port: B, role: "standalone", gwCfg: cfgB, market: marketB,
    storeDir: path.join(tmp, "store-b"), dbPath: path.join(tmp, "node-b.db"), allowDiscovery: true,
  });
  await waitHealth(A, srvA);
  await waitHealth(B, srvB);
  await new Promise((resolve) => setTimeout(resolve, 11000));
}, { timeout: 60000 });

after(() => {
  try { srvA.kill(); } catch {}
  try { srvB.kill(); } catch {}
});

async function readConvergedState(port) {
  const [defs, config, bundle] = await Promise.all([
    fetch(`http://localhost:${port}/api/devbench/project-defs`).then((r) => r.json()),
    fetch(`http://localhost:${port}/api/devbench/remote-config?projectId=${PID}`).then((r) => r.json()),
    fetch(`http://localhost:${port}/api/discovery/shared-bundle`).then((r) => r.json()),
  ]);
  assert.equal(defs.ok, true);
  assert.equal(config.ok, true);
  assert.equal(bundle.ok, true);
  const def = defs.data.find((row) => row.id === REPO);
  const entries = config.data.vehicleMap[VEHICLE].entries;
  const winningProjectOp = bundle.data.sharedOps
    .filter((op) => op.type === "projectDef.set" && op.value?.id === REPO)
    .sort((left, right) => String(left.node).localeCompare(String(right.node)))
    .at(-1);
  return { def, entries, winningProjectOp };
}

test("独立 SQLite 节点并发学习同仓库/车型后双向收敛且不丢配置", async () => {
  const [a, b] = await Promise.all([readConvergedState(A), readConvergedState(B)]);
  for (const state of [a, b]) {
    assert.deepEqual([...state.def.branchOptions].sort(), ["base", "branch-a", "branch-b"]);
    assert.deepEqual([...state.def.flavorOptions].sort(), ["base", "flavor-a", "flavor-b"]);
    assert.deepEqual(
      state.entries.map((entry) => `${entry.branch}|${entry.flavor}`).sort(),
      ["branch-a|flavor-a", "branch-b|flavor-b"],
    );
    assert.equal(state.winningProjectOp.node, "node-b");
    assert.deepEqual([...state.winningProjectOp.value.branchOptions].sort(), ["base", "branch-a", "branch-b"]);
  }
  assert.deepEqual(a.def, b.def);
  assert.deepEqual(a.entries, b.entries);
});
