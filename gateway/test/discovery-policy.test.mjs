import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const gatewayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-policy-"));
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.GATEWAY_DB_PATH = path.join(tmp, "gateway.db");
process.env.DEVBENCH_CONFIG_PATH = path.join(tmp, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(tmp, "local-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  role: "standalone",
  servers: { discovery: false, peers: [] },
}));
fs.writeFileSync(process.env.DEVBENCH_CONFIG_PATH, "{}");

let discovery;
let store;
let m2m;
before(async () => {
  discovery = await import("../services/discovery.js");
  store = await import("../services/devbench/store.js");
  m2m = await import("../services/m2m-auth.js");
});

test("跨子网引导节点只接受私网 origin，且不会扩大敏感 M2M 信任", () => {
  const config = {
    servers: {
      discoverySeeds: [
        "http://192.168.10.110:3001/",
        "http://192.168.10.110:3001",
        "https://gateway.example.com",
      ],
      peers: [],
    },
  };
  const seeds = discovery.configuredDiscoverySeeds(config, {
    AIEFFICIENCY_DISCOVERY_SEEDS: "http://172.16.128.20:3001; http://8.8.8.8:3001",
    DEVBENCH_DISCOVERY_SEEDS: "http://127.0.0.1:3101",
  });

  assert.deepEqual(seeds, [
    "http://192.168.10.110:3001",
    "http://172.16.128.20:3001",
    "http://127.0.0.1:3101",
  ]);
  assert.deepEqual([...m2m.trustedPeerOrigins(config)], []);
  assert.equal(m2m.isTrustedPeerOrigin("http://192.168.10.110:3001", config), false);

  const status = discovery.discoveryBootstrapStatus(config);
  assert.equal(status.enabled, true);
  assert.equal(status.status, "discovering");
  assert.equal(status.seedCount, 1);
  assert.equal(status.attemptedSeeds, 0);
});

test("运行数据域仍按 profile 隔离，但车型团队配置空间统一且显式 scope 保持兼容", () => {
  assert.equal(discovery.__testResolveSyncScope("shared-lan", "development-2"), "shared-lan");
  assert.equal(discovery.__testResolveSyncScope("", "development"), "profile:development");
  assert.equal(discovery.__testResolveSyncScope("", "development-2"), "profile:development-2");
  assert.equal(discovery.__testResolveSyncScope("", "production"), "production");
  assert.equal(discovery.__testResolveSyncScope("", ""), "production");

  const oldExplicit = process.env.DEVBENCH_SYNC_SCOPE;
  const oldProfile = process.env.AIEFFICIENCY_PROFILE;
  try {
    delete process.env.DEVBENCH_SYNC_SCOPE;
    process.env.AIEFFICIENCY_PROFILE = "development-3";
    assert.equal(discovery.selfInfo().syncScope, "profile:development-3");
    assert.equal(discovery.selfInfo().teamConfigSpace, "team/vehicle-source");
    assert.equal(store.getSharedBundle().syncScope, "profile:development-3");
    process.env.DEVBENCH_SYNC_SCOPE = "team-explicit";
    assert.equal(discovery.selfInfo().syncScope, "team-explicit");
    assert.equal(discovery.selfInfo().teamConfigSpace, "team/vehicle-source");
    assert.equal(store.getSharedBundle().syncScope, "team-explicit");
  } finally {
    if (oldExplicit === undefined) delete process.env.DEVBENCH_SYNC_SCOPE;
    else process.env.DEVBENCH_SYNC_SCOPE = oldExplicit;
    if (oldProfile === undefined) delete process.env.AIEFFICIENCY_PROFILE;
    else process.env.AIEFFICIENCY_PROFILE = oldProfile;
  }
});

test("缺失 syncScope 的旧节点始终按 production 解释，不继承本机开发 profile", () => {
  assert.equal(discovery.__testNormalizeAdvertisedSyncScope(undefined), "production");
  assert.equal(discovery.__testNormalizeAdvertisedSyncScope(""), "production");
  assert.equal(discovery.__testNormalizeAdvertisedSyncScope("profile:development"), "profile:development");
});

test("peer reconcile single-flight：慢周期未完成时多个 tick 只执行一次", async () => {
  let runs = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const run = discovery.__testCreateSingleFlightRunner(async () => {
    runs += 1;
    await blocked;
    return runs;
  });

  const first = run();
  const second = run();
  const third = run();
  await Promise.resolve();
  assert.equal(runs, 1);
  release();
  assert.deepEqual(await Promise.all([first, second, third]), [1, 1, 1]);

  assert.equal(await run(), 2, "上一周期结束后允许下一周期执行");
});

test("不可达 peer 使用指数退避、达到上限后保持有界并可由成功清除", () => {
  let now = 1000;
  const tracker = discovery.__testCreatePeerBackoffTracker({
    baseMs: 100,
    maxMs: 400,
    maxEntries: 2,
    now: () => now,
  });
  const peer = "http://127.0.0.1:39999/";

  assert.equal(tracker.canAttempt(peer), true);
  assert.deepEqual(tracker.failure(peer), {
    failures: 1,
    delayMs: 100,
    lastFailureAt: 1000,
    nextAttemptAt: 1100,
  });
  assert.equal(tracker.canAttempt(peer), false);
  now = 1100;
  assert.equal(tracker.canAttempt(peer), true);
  assert.equal(tracker.failure(peer).delayMs, 200);
  now = 1300;
  assert.equal(tracker.failure(peer).delayMs, 400);
  now = 1700;
  assert.equal(tracker.failure(peer).delayMs, 400, "退避不得超过上限");

  tracker.failure("http://127.0.0.1:39998");
  tracker.failure("http://127.0.0.1:39997");
  assert.equal(tracker.size(), 2, "退避状态表不得无限增长");

  tracker.success(peer);
  assert.equal(tracker.inspect(peer), null);
  assert.equal(tracker.canAttempt(peer), true);
});

test("peer fetch 在退避窗口内不重复发起网络请求", async () => {
  let now = 2000;
  let calls = 0;
  const tracker = discovery.__testCreatePeerBackoffTracker({
    baseMs: 100,
    maxMs: 400,
    now: () => now,
  });
  const fetchPeerJson = discovery.__testCreatePeerJsonFetcher(async () => {
    calls += 1;
    throw new Error("offline");
  }, tracker);

  const first = await fetchPeerJson("http://127.0.0.1:39996", "/api/discovery/info", 10);
  const skipped = await fetchPeerJson("http://127.0.0.1:39996", "/api/devbench/audit-since", 10);
  assert.equal(first.attempted, true);
  assert.equal(first.backoff.delayMs, 100);
  assert.equal(skipped.skipped, true);
  assert.equal(calls, 1);

  now = 2100;
  await fetchPeerJson("http://127.0.0.1:39996", "/api/discovery/info", 10);
  assert.equal(calls, 2);
});

test("旧 peer 返回非 JSON 时不触发整机退避", async () => {
  let calls = 0;
  const tracker = discovery.__testCreatePeerBackoffTracker();
  const fetchPeerJson = discovery.__testCreatePeerJsonFetcher(async () => {
    calls += 1;
    return { json: async () => { throw new SyntaxError("not json"); } };
  }, tracker);
  const peer = "http://127.0.0.1:39995";

  const first = await fetchPeerJson(peer, "/api/new-endpoint");
  const second = await fetchPeerJson(peer, "/api/discovery/info");
  assert.equal(first.available, true);
  assert.equal(first.invalidJson, true);
  assert.equal(second.attempted, true);
  assert.equal(tracker.inspect(peer), null);
  assert.equal(calls, 2);
});

test("发现同步采用事件合并与低频兜底，不把版本广播放大成全量轮询", () => {
  const source = fs.readFileSync(path.join(gatewayRoot, "services", "discovery.js"), "utf8");
  assert.match(source, /DEVBENCH_PEER_METADATA_INTERVAL_MS\) \|\| 60_000/);
  assert.match(source, /DEVBENCH_PEER_RECONCILE_INTERVAL_MS\) \|\| 5 \* 60_000/);
  assert.match(source, /DEVBENCH_PEER_EVENT_RECONCILE_DEBOUNCE_MS\) \|\| 10_000/);
  assert.match(source, /replicationPeerKey\(info\)/);
  assert.match(source, /pendingSharedPeers\.set\(replicationKey, \{ info, changedAt: Date\.now\(\) \}\)/);
  assert.match(source, /dedupeReplicationPeers\(getKnownNodes\(me\), me\)/);
  assert.match(source, /runSharedConfigReconcile\(dedupeReplicationPeers\(peers, me\), me\)/);
  assert.match(source, /verifyLanSyncAdvertisement\(info\)/);
  assert.match(source, /observeLanSyncPeer\(info\)/);
  assert.match(source, /localIpCache = \{ configured: "", value: "", expiresAt: 0 \}/);
  const eventScheduler = source.slice(
    source.indexOf("function schedulePeerReconcile"),
    source.indexOf("export function initDiscovery"),
  );
  assert.doesNotMatch(
    eventScheduler,
    /runPeerReconcileCycle\(\)/,
    "UDP 版本事件只能拉共享配置，不能触发审计/管理员/用户数据全量同步",
  );
});

test("UDP 保持异步监听并降为低频发现，广播本身不触发旧配置播种", () => {
  const source = fs.readFileSync(path.join(gatewayRoot, "services", "discovery.js"), "utf8");
  assert.match(source, /DISCOVERY_BROADCAST_INTERVAL_MS/);
  assert.match(source, /Math\.max\(60_000, Math\.min\(120_000,/);
  assert.match(source, /setInterval\(\(\) => broadcastSelf\(port\), DISCOVERY_BROADCAST_INTERVAL_MS\)/);
  assert.match(source, /sock\.on\("message",/);
  assert.doesNotMatch(source, /skipAdminCheck/);
});

test("已建立 LAN WebSocket 的手动 peer 不再执行 HTTP 探活", () => {
  assert.equal(discovery.__testShouldProbeManualPeer({ lanSyncOnline: true }), false);
  assert.equal(discovery.__testShouldProbeManualPeer({ lanSyncOnline: false }), true);
});

test("已配对节点只在 IP 变化时更新成员地址，在线判定不依赖 UDP 写库", () => {
  const source = fs.readFileSync(path.join(gatewayRoot, "services", "lan-sync", "index.js"), "utf8");
  const observe = source.slice(
    source.indexOf("export function observeLanSyncPeer"),
    source.indexOf("function sendOps", source.indexOf("export function observeLanSyncPeer")),
  );
  assert.match(observe, /comparableOrigin\(member\.host\) !== comparableOrigin\(host\)/);
  assert.match(observe, /syncStore\.touchMember\(peerNodeId/);
  assert.match(observe, /connections\.get\(peerNodeId\)\?\.authenticated/);
  assert.ok(
    observe.indexOf("comparableOrigin(member.host)") < observe.indexOf("connections.get(peerNodeId)?.authenticated"),
    "IP 变化应先持久化，WebSocket 在线状态仅负责跳过重连",
  );
});

test("共享 bundle 响应按 sharedVersion 缓存序列化结果和 ETag", () => {
  const source = fs.readFileSync(path.join(gatewayRoot, "routes", "discovery.js"), "utf8");
  assert.match(source, /sharedBundleResponseCache = \{ version: 0, body: "" \}/);
  assert.match(source, /sharedBundleResponseCache\.version !== currentVersion/);
  assert.match(source, /body: JSON\.stringify\(\{ ok: true, data: bundle \}\)/);
  assert.match(source, /res\.set\("ETag", `"shared-\$\{sharedBundleResponseCache\.version\}"`\)/);
  assert.match(source, /res\.send\(sharedBundleResponseCache\.body\)/);
});
