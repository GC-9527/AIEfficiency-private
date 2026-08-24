import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { canonicalJson, fingerprintPublicKey } from "../services/lan-sync/identity.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lan-sync-"));
process.env.GATEWAY_DB_PATH = path.join(root, "data.db");
process.env.GATEWAY_CONFIG_PATH = path.join(root, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(root, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(root, "local-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(root, "store");
process.env.LAN_SYNC_IDENTITY_PATH = path.join(root, "identity.json");
process.env.DEVBENCH_SYNC_SCOPE = "lan-sync-test";
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  role: "standalone",
  servers: { nodeId: "node-a", nodeName: "Node A", discovery: false },
  lanSync: {
    syncMode: "peer",
    allowInsecureTransport: true,
    teamConfigSpace: "team/test/vehicle-source",
  },
  teambition: { projects: [{ id: "project-a", name: "Project A" }] },
}));
fs.writeFileSync(process.env.DEVBENCH_CONFIG_PATH, "{}");

let db;
let store;
let sync;
let lanStore;
let config;

before(async () => {
  db = await import("../db/sqlite.js");
  store = await import("../services/devbench/store.js");
  sync = await import("../services/lan-sync/index.js");
  lanStore = await import("../services/lan-sync/store.js");
  config = await import("../services/config.js");
});

after(() => {
  sync?.stopLanSync?.();
  if (db?.default?.open) db.default.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  const sqlite = db.default;
  for (const table of [
    "lan_sync_nonces",
    "lan_sync_peer_delivery",
    "lan_sync_peer_cursors",
    "lan_sync_conflicts",
    "lan_sync_drafts",
    "lan_sync_idempotency",
    "lan_sync_ops",
    "lan_sync_members",
    "lan_sync_meta",
    "admin_audit",
  ]) sqlite.prepare(`DELETE FROM ${table}`).run();
  db.setUserData("__devbench_shared__", "shared", {
    byProject: {},
    dingtalkMsgConfig: null,
    _sharedVersion: 1,
  }, "test");
  config.updateConfig({
    lanSync: {
      ...config.getConfig().lanSync,
      syncMode: "peer",
      teamConfigSpace: "team/test/vehicle-source",
      groupId: "group-test-existing",
    },
  });
});

function mapping(branch = "main") {
  return {
    apps: [{
      appName: "应用市场",
      repos: [{ repoId: "appMarket", branch, flavor: "avatr8678" }],
    }],
    prodReleaseDir: "",
    needsResign: false,
  };
}

function publicationInput(overrides = {}) {
  return {
    configSpace: "team/test/vehicle-source",
    projectId: "project-a",
    idempotencyKey: "publish-1",
    changes: [{
      flavor: "avatr8678",
      action: "set",
      mapping: mapping(),
      baseRevision: "0",
    }],
    ...overrides,
  };
}

function signedDiscoveryCandidate(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const fingerprint = fingerprintPublicKey(publicKeyPem);
  const nodeId = `lan-${fingerprint.slice(0, 24)}`;
  const groupHex = createHash("sha256")
    .update("devbench-lan-sync:team/test/vehicle-source", "utf8")
    .digest("hex");
  const candidate = {
    id: nodeId,
    lanSyncNodeId: nodeId,
    name: "Discovered Node",
    nodeName: "Discovered Node",
    host: "http://192.168.10.42:3101",
    protocolVersion: 2,
    schemaVersion: 1,
    syncMode: "peer",
    configSpaces: ["team/test/vehicle-source"],
    certificateFingerprint: fingerprint,
    publicKey: publicKeyPem,
    lanSyncGroupId: `lan-group-${groupHex.slice(0, 8)}-${groupHex.slice(8, 12)}-${groupHex.slice(12, 16)}-${groupHex.slice(16, 20)}-${groupHex.slice(20, 32)}`,
    ts: Date.now(),
    ...overrides,
  };
  const data = {
    nodeId: candidate.lanSyncNodeId,
    host: candidate.host,
    protocolVersion: candidate.protocolVersion,
    schemaVersion: candidate.schemaVersion,
    configSpaces: candidate.configSpaces,
    certificateFingerprint: candidate.certificateFingerprint,
    timestamp: candidate.ts,
    ...(candidate.lanSyncGroupId ? { lanSyncGroupId: candidate.lanSyncGroupId } : {}),
    ...(candidate.lanSyncRequestId ? { lanSyncRequestId: candidate.lanSyncRequestId } : {}),
  };
  candidate.advertisementSignature = sign(
    null,
    Buffer.from(canonicalJson(data), "utf8"),
    privateKey,
  ).toString("base64");
  return candidate;
}

test("LAN 同步 schema、配置空间与设备身份可用", () => {
  const tables = db.default.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name LIKE 'lan_sync_%'
    ORDER BY name
  `).all().map((row) => row.name);
  assert.ok(tables.includes("lan_sync_ops"));
  assert.ok(tables.includes("lan_sync_peer_delivery"));
  assert.ok(tables.includes("lan_sync_conflicts"));
  assert.ok(tables.includes("lan_sync_members"));

  const bundle = sync.localPairingBundle("http://127.0.0.1:3001");
  assert.match(bundle.nodeId, /^lan-[a-f0-9]{24}$/);
  assert.notEqual(bundle.nodeId, "node-a", "LAN 身份不得复用可被 profile 克隆的 servers.nodeId");
  assert.equal(bundle.configSpaces[0], "team/test/vehicle-source");
  assert.match(bundle.certificateFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(bundle.publicKey.includes("BEGIN PUBLIC KEY"));
});

test("管理员主动同步在没有在线成员时只请求发现，不发布本机快照", () => {
  const before = store.getRemoteConfig("project-a");
  const result = sync.requestVehicleSyncNow({ requestId: "manual-sync-no-peer" });
  const after = store.getRemoteConfig("project-a");

  assert.equal(result.status, "waiting-for-peer");
  assert.equal(result.requestedPeers, 0);
  assert.equal(result.sentOperations, 0);
  assert.deepEqual(after.vehicleMap, before.vehicleMap);
  assert.deepEqual(lanStore.currentVersionVector("team/test/vehicle-source"), {});
});

test("签名 UDP 主动发现请求可验证且篡改 requestId 后失败", () => {
  const candidate = signedDiscoveryCandidate({ lanSyncRequestId: "ab".repeat(16) });
  assert.equal(sync.validateLanSyncDiscoverySolicitation(candidate)?.requestId, candidate.lanSyncRequestId);
  assert.equal(sync.validateLanSyncDiscoverySolicitation({
    ...candidate,
    lanSyncRequestId: "cd".repeat(16),
  }), null);
});

test("普通发布权限不能伪造冲突解决因果关系", () => {
  assert.throws(
    () => sync.publishVehicleChanges(publicationInput({
      idempotencyKey: "forged-conflict-resolution",
      changes: [{
        ...publicationInput().changes[0],
        resolves: ["local-revision", "remote-revision"],
      }],
    }), { role: "admin" }),
    (error) => error.code === "LAN_SYNC_RESOLVE_PERMISSION_REQUIRED" && error.statusCode === 403,
  );
  assert.deepEqual(lanStore.currentVersionVector("team/test/vehicle-source"), {});
});

test("车型 projectId 在入口归一化且空值被拒绝", () => {
  assert.equal(store.normalizeVehicleProjectId("  project-a  ", { required: true }), "project-a");
  assert.throws(
    () => store.normalizeVehicleProjectId("   ", { required: true }),
    (error) => error.code === "VEHICLE_PROJECT_ID_REQUIRED",
  );
  const preview = sync.previewVehiclePublication({
    ...publicationInput(),
    projectId: "  project-a  ",
  });
  assert.equal(preview.projectId, "project-a");
});

test("显式发布把快照、操作日志、幂等键和审计放进同一提交", () => {
  assert.deepEqual(store.getRemoteConfig("project-a").vehicleMap, {});
  const preview = sync.previewVehiclePublication(publicationInput());
  assert.equal(preview.ok, true);
  assert.equal(preview.diff.added.length, 1);

  const result = sync.publishVehicleChanges(publicationInput(), {
    role: "super",
    name: "测试管理员",
  }, { ip: "127.0.0.1" });
  assert.equal(result.ok, true);
  assert.equal(result.localCommitted, true);
  assert.equal(result.ops.length, 1);
  assert.equal(store.getRemoteConfig("project-a").vehicleMap.avatr8678.entries[0].branch, "main");
  assert.equal(db.default.prepare("SELECT COUNT(*) AS count FROM lan_sync_ops").get().count, 1);
  const persistedOp = db.default.prepare(`
    SELECT change_set_index, change_set_size, change_set_hash FROM lan_sync_ops
  `).get();
  assert.equal(persistedOp.change_set_index, 0);
  assert.equal(persistedOp.change_set_size, 1);
  assert.match(persistedOp.change_set_hash, /^[a-f0-9]{64}$/);
  assert.equal(db.default.prepare("SELECT COUNT(*) AS count FROM lan_sync_idempotency").get().count, 1);
  assert.equal(db.default.prepare("SELECT COUNT(*) AS count FROM admin_audit WHERE action=?").get("车型配置.发布到团队").count, 1);

  const retry = sync.publishVehicleChanges({
    ...publicationInput(),
    changes: [{
      ...publicationInput().changes[0],
      mapping: mapping("stale-retry-must-not-apply"),
    }],
  }, { role: "super" });
  assert.equal(retry.idempotent, true);
  assert.equal(store.getRemoteConfig("project-a").vehicleMap.avatr8678.entries[0].branch, "main");
  assert.equal(db.default.prepare("SELECT COUNT(*) AS count FROM lan_sync_ops").get().count, 1);
});

test("一次性加入码只允许纯私有局域网 origin，拒绝公网与带路径目标", () => {
  assert.equal(sync.normalizeLanSyncInvitationOrigin("http://192.168.10.110:3001"), "http://192.168.10.110:3001");
  assert.equal(sync.normalizeLanSyncInvitationOrigin("http://172.16.129.94:3101"), "http://172.16.129.94:3101");
  assert.equal(sync.normalizeLanSyncInvitationOrigin("http://127.0.0.1:3001"), "http://127.0.0.1:3001");
  assert.equal(sync.normalizeLanSyncInvitationOrigin("https://8.8.8.8"), "");
  assert.equal(sync.normalizeLanSyncInvitationOrigin("http://192.168.10.110:3001/api/admin"), "");
  assert.equal(sync.normalizeLanSyncInvitationOrigin("http://user:pass@192.168.10.110:3001"), "");
});

test("管理员第一次发布自动建立同步组，不需要额外设置动作", () => {
  config.updateConfig({ lanSync: { ...config.getConfig().lanSync, syncMode: "disabled", groupId: "" } });
  try {
    store.setVehicleMapping("project-a", "avatr8678", mapping("release/existing-admin-config"));
    const result = sync.publishVehicleChanges(publicationInput({
      idempotencyKey: "standalone-local-publish",
      changes: [{
        flavor: "geelyp162",
        action: "set",
        mapping: mapping("release/geely-p162"),
        baseRevision: "0",
      }],
    }), { role: "super", name: "Standalone Admin" });

    assert.equal(result.ok, true);
    assert.equal(result.localCommitted, true);
    assert.equal(result.publicationScope, "team");
    assert.ok(result.automaticSeededOperations >= 1);
    assert.equal(sync.configuredLanSyncMode(), "peer");
    assert.equal(
      config.getConfig().lanSync.groupId,
      signedDiscoveryCandidate().lanSyncGroupId,
      "同一 teamConfigSpace 的独立首发节点必须收敛到同一个自动组",
    );
    assert.equal(result.pending, 0);
    assert.equal(result.offline, 0);
    assert.equal(result.deliveries.length, 0);
    assert.equal(db.default.prepare("SELECT COUNT(*) AS count FROM lan_sync_peer_delivery").get().count, 0);
    assert.equal(
      db.default.prepare("SELECT COUNT(*) AS count FROM lan_sync_ops WHERE entity_type='vehicle'").get().count,
      2,
      "第一次管理员发布应同时把现有管理员车型配置建立为基线",
    );
    assert.equal(
      store.getRemoteConfig("project-a").vehicleMap.geelyp162.entries[0].branch,
      "release/geely-p162",
    );
    assert.equal(
      db.default.prepare("SELECT COUNT(*) AS count FROM admin_audit WHERE action=?")
        .get("车型配置.发布到团队").count,
      1,
    );
  } finally {
    config.updateConfig({ lanSync: { ...config.getConfig().lanSync, syncMode: "peer" } });
  }
});

test("旧版 peer 缺少 groupId 时启动不迁移，下一次管理员真实发布才自动补建组", () => {
  config.updateConfig({ lanSync: { ...config.getConfig().lanSync, syncMode: "peer", groupId: "" } });
  sync.initLanSync();
  sync.stopLanSync();
  assert.equal(config.getConfig().lanSync.groupId, "");
  assert.equal(db.default.prepare("SELECT COUNT(*) AS count FROM lan_sync_ops").get().count, 0);

  const result = sync.publishVehicleChanges(publicationInput({
    idempotencyKey: "legacy-peer-first-real-publish",
    changes: [{
      flavor: "geelyp162",
      action: "set",
      mapping: mapping("release/migrated"),
      baseRevision: "0",
    }],
  }), { role: "admin", name: "迁移管理员" });
  assert.equal(result.publicationScope, "team");
  assert.match(config.getConfig().lanSync.groupId, /^lan-group-/);
});

test("真实发布已提交但同步组配置丢失时，幂等重试会自动恢复组而不重复写操作", () => {
  const input = publicationInput({ idempotencyKey: "recover-group-on-idempotent-retry" });
  const first = sync.publishVehicleChanges(input, { role: "admin", name: "恢复管理员" });
  assert.equal(first.ok, true);
  assert.equal(db.default.prepare("SELECT COUNT(*) AS count FROM lan_sync_ops").get().count, 1);

  config.updateConfig({ lanSync: { ...config.getConfig().lanSync, syncMode: "disabled", groupId: "" } });
  const retry = sync.publishVehicleChanges(input, { role: "admin", name: "恢复管理员" });
  assert.equal(retry.idempotent, true);
  assert.equal(sync.configuredLanSyncMode(), "peer");
  assert.match(config.getConfig().lanSync.groupId, /^lan-group-/);
  assert.equal(
    db.default.prepare("SELECT COUNT(*) AS count FROM lan_sync_ops WHERE entity_type='vehicle'").get().count,
    1,
    "幂等恢复不得重复写入同一车型操作",
  );
});

test("receive-only 节点仍拒绝本地和团队车型发布", () => {
  config.updateConfig({ lanSync: { ...config.getConfig().lanSync, syncMode: "receive-only" } });
  try {
    assert.throws(
      () => sync.publishVehicleChanges(publicationInput({ idempotencyKey: "receive-only-blocked" }), {
        role: "super",
        name: "Receive Only Admin",
      }),
      (error) => error.code === "LAN_SYNC_PUBLISH_DISABLED",
    );
    assert.deepEqual(store.getRemoteConfig("project-a").vehicleMap, {});
  } finally {
    config.updateConfig({ lanSync: { ...config.getConfig().lanSync, syncMode: "peer" } });
  }
});

test("多操作发布携带完整 manifest，团队 payload 排除本机目录和未知字段", () => {
  store.setVehicleMapping("project-a", "avatr8678", {
    ...mapping("release/local"),
    prodReleaseDir: "\\\\host\\private-release",
    accessToken: "local-only",
  });
  const result = sync.publishVehicleChanges(publicationInput({
    changes: [
      {
        ...publicationInput().changes[0],
        mapping: {
          ...mapping("release/a"),
          prodReleaseDir: "\\\\host\\private-release",
          accessToken: "must-not-sync",
        },
      },
      {
        flavor: "geelye22",
        action: "set",
        mapping: mapping("release/b"),
        baseRevision: "0",
      },
    ],
  }), { role: "super" });
  assert.equal(result.ops.length, 2);
  assert.deepEqual(result.ops.map((op) => op.changeSetIndex), [0, 1]);
  assert.ok(result.ops.every((op) => op.changeSetSize === 2));
  assert.equal(new Set(result.ops.map((op) => op.changeSetHash)).size, 1);
  assert.match(result.ops[0].changeSetHash, /^[a-f0-9]{64}$/);
  assert.equal(result.ops[0].payload.mapping.prodReleaseDir, undefined);
  assert.equal(result.ops[0].payload.mapping.accessToken, undefined);
  const localMapping = store.getRemoteConfig("project-a").vehicleMap.avatr8678;
  assert.equal(localMapping.prodReleaseDir, "\\\\host\\private-release");
  assert.equal(localMapping.accessToken, "local-only");

  const fullManifest = sync.validateChangeSetManifest(result.ops, result.changeSetId);
  assert.equal(fullManifest.ok, true);
  const truncated = sync.validateChangeSetManifest(result.ops.slice(0, 1), result.changeSetId);
  assert.equal(truncated.ok, false);
  assert.match(truncated.error, /操作数|manifest/);
});

test("车型及依赖仓库定义在同一签名 change set 和事务中提交", () => {
  const result = sync.publishVehicleChanges(publicationInput({
    projectDefs: [{
      action: "set",
      definition: {
        id: "dependency-repo",
        name: "Dependency Repo",
        https: "https://example.com/dependency.git",
        projectType: "sdk",
      },
      baseRevision: "0",
    }],
    changes: [{
      ...publicationInput().changes[0],
      mapping: {
        apps: [{
          appName: "应用市场",
          repos: [{ repoId: "dependency-repo", branch: "main", flavor: "avatr8678" }],
        }],
      },
    }],
  }), { role: "super" });
  assert.equal(result.ops.length, 2);
  assert.deepEqual(result.ops.map((op) => op.entityType), ["project-definition", "vehicle"]);
  assert.equal(new Set(result.ops.map((op) => op.changeSetHash)).size, 1);
  assert.equal(store.getProjectDef("dependency-repo").name, "Dependency Repo");
  assert.equal(
    store.getRemoteConfig("project-a").vehicleMap.avatr8678.entries[0].projectId,
    "dependency-repo",
  );
});

test("missing project definition is rejected during preview", () => {
  assert.throws(
    () => sync.previewVehiclePublication(publicationInput({
      changes: [{
        ...publicationInput().changes[0],
        mapping: {
          apps: [{
            appName: "Dependency Check",
            repos: [{ repoId: "missing-repo", branch: "main", flavor: "avatr8678" }],
          }],
        },
      }],
    })),
    (error) => error.code === "PROJECT_DEF_DEPENDENCY_MISSING",
  );
});

test("deleting a project definition referenced by an existing vehicle is rejected", () => {
  const first = sync.publishVehicleChanges(publicationInput({
    idempotencyKey: "dependency-delete-first",
    projectDefs: [{
      id: "referenced-repo",
      action: "set",
      definition: {
        id: "referenced-repo",
        name: "Referenced Repo",
        https: "https://example.com/referenced.git",
      },
      baseRevision: "0",
    }],
    changes: [{
      ...publicationInput().changes[0],
      mapping: {
        apps: [{
          appName: "Dependency Delete",
          repos: [{ repoId: "referenced-repo", branch: "main", flavor: "avatr8678" }],
        }],
      },
    }],
  }), { role: "super" });
  const definitionRevision = first.ops.find((op) => op.entityType === "project-definition").opId;
  assert.throws(
    () => sync.previewVehiclePublication(publicationInput({
      changes: [],
      projectDefs: [{
        id: "referenced-repo",
        action: "delete",
        baseRevision: definitionRevision,
      }],
    })),
    (error) => error.code === "PROJECT_DEF_DEPENDENCY_MISSING",
  );
});

test("project definition can publish alone and resolve a conflict", () => {
  const first = sync.publishVehicleChanges(publicationInput({
    idempotencyKey: "project-def-only",
    changes: [],
    projectDefs: [{
      id: "conflict-repo",
      action: "set",
      definition: {
        id: "conflict-repo",
        name: "Conflict Repo",
        https: "https://example.com/conflict.git",
      },
      baseRevision: "0",
    }],
  }), { role: "super" });
  assert.equal(first.ops.length, 1);
  assert.equal(first.ops[0].entityType, "project-definition");

  const conflict = lanStore.createConflict({
    configSpace: "team/test/vehicle-source",
    entityType: "project-definition",
    entityKey: "conflict-repo",
    localRevision: first.ops[0].opId,
    remoteRevision: "remote-project-def-revision",
    localPayload: store.getProjectDef("conflict-repo"),
    remotePayload: { ...store.getProjectDef("conflict-repo"), name: "Remote Conflict Repo" },
  });
  const resolved = sync.resolveVehicleConflict(
    conflict.conflictId,
    { ...store.getProjectDef("conflict-repo"), name: "Resolved Repo" },
    { role: "super" },
    "resolve-project-def",
  );
  assert.equal(resolved.ops.length, 1);
  assert.equal(resolved.ops[0].entityType, "project-definition");
  assert.deepEqual(resolved.ops[0].payload.resolves, [
    first.ops[0].opId,
    "remote-project-def-revision",
  ]);
  assert.equal(store.getProjectDef("conflict-repo").name, "Resolved Repo");
  assert.equal(lanStore.getConflict(conflict.conflictId).status, "resolved");
});

test("保留本机值也必须发布因果解决操作，不能被 no-op 优化吞掉", () => {
  const first = sync.publishVehicleChanges(publicationInput({
    idempotencyKey: "resolve-local-first",
    changes: [{
      ...publicationInput().changes[0],
      mapping: mapping("release/local"),
    }],
  }), { role: "super" });
  const conflict = lanStore.createConflict({
    configSpace: "team/test/vehicle-source",
    entityType: "vehicle",
    entityKey: "project-a/avatr8678",
    localRevision: first.ops[0].opId,
    remoteRevision: "remote-vehicle-revision",
    localPayload: mapping("release/local"),
    remotePayload: mapping("release/remote"),
  });

  const resolved = sync.resolveVehicleConflict(
    conflict.conflictId,
    mapping("release/local"),
    { role: "super" },
    "resolve-keep-local",
  );

  assert.equal(resolved.noOp, undefined);
  assert.equal(resolved.ops.length, 1);
  assert.equal(resolved.ops[0].action, "resolve");
  assert.deepEqual(resolved.ops[0].payload.resolves, [
    first.ops[0].opId,
    "remote-vehicle-revision",
  ]);
  assert.equal(lanStore.getConflict(conflict.conflictId).status, "resolved");
});

test("吊销成员不能由普通重新配对恢复，超级管理员可显式重新启用", () => {
  const bundle = { ...sync.localPairingBundle(), nodeId: "node-b", nodeName: "Node B" };
  sync.pairMember(bundle);
  sync.updateLanSyncMemberState("node-b", "revoked");
  assert.throws(
    () => sync.pairMember(bundle),
    (error) => error.code === "LAN_SYNC_MEMBER_REACTIVATION_FORBIDDEN",
  );
  const restored = sync.pairMember(bundle, { allowReactivation: true });
  assert.equal(restored.state, "active");
});

test("同内容保存是 no-op，过期实体基线在预览阶段被拒绝", () => {
  const first = sync.publishVehicleChanges(publicationInput(), { role: "super" });
  const currentRevision = first.ops[0].opId;
  const noOp = sync.publishVehicleChanges(publicationInput({
    idempotencyKey: "publish-no-op",
    changes: [{
      ...publicationInput().changes[0],
      baseRevision: currentRevision,
    }],
  }), { role: "super" });
  assert.equal(noOp.noOp, true);
  assert.equal(db.default.prepare("SELECT COUNT(*) AS count FROM lan_sync_ops").get().count, 1);
  const noOpRetry = sync.publishVehicleChanges(publicationInput({
    idempotencyKey: "publish-no-op",
    changes: [{
      ...publicationInput().changes[0],
      mapping: mapping("must-not-apply-after-noop"),
      baseRevision: currentRevision,
    }],
  }), { role: "super" });
  assert.equal(noOpRetry.idempotent, true);
  assert.equal(noOpRetry.noOp, true);
  assert.equal(store.getRemoteConfig("project-a").vehicleMap.avatr8678.entries[0].branch, "main");

  const stale = sync.previewVehiclePublication(publicationInput({
    idempotencyKey: "publish-stale",
    changes: [{
      ...publicationInput().changes[0],
      mapping: mapping("feature/stale"),
      baseRevision: "0",
    }],
  }));
  assert.equal(stale.ok, false);
  assert.equal(stale.conflicts.length, 1);
});

test("多车型发布中途失败会回滚快照、op、幂等键与审计", () => {
  const sqlite = db.default;
  sqlite.exec(`
    CREATE TEMP TABLE lan_sync_test_write_guard(count INTEGER NOT NULL);
    INSERT INTO lan_sync_test_write_guard(count) VALUES(0);
    CREATE TEMP TRIGGER lan_sync_test_abort_second
    BEFORE UPDATE ON devbench_userdata
    WHEN NEW.user_key='__devbench_shared__' AND NEW.kind='shared'
    BEGIN
      UPDATE lan_sync_test_write_guard SET count=count+1;
      SELECT CASE WHEN (SELECT count FROM lan_sync_test_write_guard) >= 2
        THEN RAISE(ABORT, 'forced second snapshot write failure') END;
    END;
  `);
  try {
    assert.throws(() => sync.publishVehicleChanges(publicationInput({
      projectDefs: [{
        id: "rollback-repo",
        action: "set",
        definition: {
          id: "rollback-repo",
          name: "Rollback Repo",
          https: "https://example.com/rollback.git",
        },
        baseRevision: "0",
      }],
      changes: [{
        ...publicationInput().changes[0],
        mapping: {
          apps: [{
            appName: "Rollback",
            repos: [{ repoId: "rollback-repo", branch: "main", flavor: "avatr8678" }],
          }],
        },
      }],
    }), { role: "super" }), /forced second snapshot write failure/);
  } finally {
    sqlite.exec("DROP TRIGGER IF EXISTS lan_sync_test_abort_second; DROP TABLE IF EXISTS lan_sync_test_write_guard;");
  }

  assert.deepEqual(store.getRemoteConfig("project-a").vehicleMap, {});
  assert.equal(store.getProjectDef("rollback-repo"), null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM lan_sync_ops").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM lan_sync_idempotency").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM admin_audit WHERE action=?").get("车型配置.发布到团队").count, 0);
});

test("草稿按稳定用户保存且不改变团队快照", () => {
  const draft = sync.saveVehicleDraft({
    ...publicationInput(),
    draftId: "draft-1",
  }, { role: "super" });
  assert.equal(draft.ownerUserId, "local-super");
  assert.equal(draft.changes.length, 1);
  assert.deepEqual(store.getRemoteConfig("project-a").vehicleMap, {});
  assert.equal(db.default.prepare("SELECT COUNT(*) AS count FROM lan_sync_drafts").get().count, 1);
});

test("启动、读取和发现都不生成 baseline，只有管理员明确发布时才生成同步操作", () => {
  store.setVehicleMapping("project-a", "avatr8678", mapping("release/legacy"));
  store.setVehicleMapping("project-a", "avatr8678", null);
  assert.equal(store.getVehicleSyncTombstones().length, 1);
  sync.initLanSync();
  sync.stopLanSync();
  store.getRemoteConfig("project-a");
  // initLanSync 和 UDP 发现都不得自动播种，因此操作数为 0。
  assert.equal(db.default.prepare("SELECT COUNT(*) AS count FROM lan_sync_ops").get().count, 0);
  assert.throws(
    () => sync.publishExistingVehicleConfiguration({}, { skipAdminCheck: true }),
    (error) => error?.code === "LAN_SYNC_ADMIN_REQUIRED",
  );
  const migrated = sync.publishExistingVehicleConfiguration({ role: "super", name: "测试管理员" });
  assert.ok(migrated.created >= 1);
  const op = db.default.prepare(`
    SELECT action, payload_json, change_set_hash FROM lan_sync_ops
    WHERE entity_type='vehicle' AND action='delete'
  `).get();
  assert.equal(op.action, "delete");
  assert.equal(JSON.parse(op.payload_json).mapping, null);
  assert.match(op.change_set_hash, /^[a-f0-9]{64}$/);
});

test("新 Gateway 无需任何操作自动加入，但不会播种自己的旧配置", () => {
  store.setVehicleMapping("project-a", "geelyp162", mapping("release/local-only"));
  config.updateConfig({
    lanSync: {
      ...config.getConfig().lanSync,
      syncMode: "disabled",
      groupId: "",
    },
  });
  const candidate = signedDiscoveryCandidate();

  const joined = sync.autoJoinLanSyncDiscovery(candidate);
  assert.equal(joined.joined, true);
  assert.equal(joined.member.nodeId, candidate.lanSyncNodeId);
  assert.equal(sync.configuredLanSyncMode(), "peer");
  assert.equal(config.getConfig().lanSync.groupId, candidate.lanSyncGroupId);
  assert.equal(db.default.prepare("SELECT COUNT(*) AS count FROM lan_sync_members").get().count, 1);
  assert.equal(db.default.prepare("SELECT COUNT(*) AS count FROM lan_sync_ops").get().count, 0);

  const tampered = sync.autoJoinLanSyncDiscovery({
    ...candidate,
    host: "http://192.168.10.99:3101",
  });
  assert.equal(tampered.joined, false, "被篡改的广播不得成为自动加入依据");
});

test("自动加入会丢弃无组身份的旧传输历史，但保留本机物化配置", () => {
  const legacy = sync.publishVehicleChanges(publicationInput({
    idempotencyKey: "legacy-transport-history",
    changes: [{
      flavor: "legacy-local",
      action: "set",
      mapping: mapping("must-stay-local"),
      baseRevision: "0",
    }],
  }), { role: "admin", name: "旧版管理员" });
  assert.equal(legacy.ok, true);
  assert.ok(db.default.prepare("SELECT COUNT(*) AS count FROM lan_sync_ops").get().count >= 1);
  config.updateConfig({
    lanSync: {
      ...config.getConfig().lanSync,
      syncMode: "disabled",
      groupId: "",
    },
  });

  const joined = sync.autoJoinLanSyncDiscovery(signedDiscoveryCandidate());
  assert.equal(joined.joined, true);
  assert.ok(joined.discardedSyncState.operations >= 1);
  assert.equal(db.default.prepare("SELECT COUNT(*) AS count FROM lan_sync_ops").get().count, 0);
  assert.equal(
    store.getRemoteConfig("project-a").vehicleMap["legacy-local"].entries[0].branch,
    "must-stay-local",
    "本机配置仍可见，但没有操作日志就不会自动上传",
  );
});

test("显式 receive-only 安全角色不会被局域网自动发现改写为 peer", () => {
  config.updateConfig({
    lanSync: {
      ...config.getConfig().lanSync,
      syncMode: "receive-only",
      groupId: "",
    },
  });
  const result = sync.autoJoinLanSyncDiscovery(signedDiscoveryCandidate());
  assert.equal(result.joined, false);
  assert.equal(result.reason, "receive-only");
  assert.equal(sync.configuredLanSyncMode(), "receive-only");
  assert.equal(db.default.prepare("SELECT COUNT(*) AS count FROM lan_sync_members").get().count, 0);
});

test("compaction 只删除已安全越过的历史 op，并保留实体 head 与 vector floor", () => {
  let revision = "0";
  for (let index = 0; index < 3; index++) {
    const result = sync.publishVehicleChanges(publicationInput({
      idempotencyKey: `compact-${index}`,
      changes: [{
        ...publicationInput().changes[0],
        mapping: mapping(`release/${index}`),
        baseRevision: revision,
      }],
    }), { role: "super" });
    revision = result.ops[0].opId;
  }
  db.default.prepare("UPDATE lan_sync_ops SET created_at=1").run();
  const originNodeId = sync.localPairingBundle().nodeId;
  sync.pairMember({ ...sync.localPairingBundle(), nodeId: "compact-peer", nodeName: "Compact Peer" });
  assert.equal(sync.compactLanSyncOperations().deleted, 0);
  lanStore.updatePeerCursor("compact-peer", { [originNodeId]: 2 });
  const compacted = sync.compactLanSyncOperations();
  assert.equal(compacted.deleted, 2);
  assert.equal(db.default.prepare("SELECT COUNT(*) AS count FROM lan_sync_ops").get().count, 1);
  assert.equal(lanStore.currentVersionVector("team/test/vehicle-source")[originNodeId], 3);
  assert.equal(lanStore.compactionFloor(originNodeId), 2);
});

test("compaction preserves complete signed change-set manifests", () => {
  const first = sync.publishVehicleChanges(publicationInput({
    idempotencyKey: "compact-manifest-first",
    projectDefs: [{
      id: "compact-manifest-repo",
      action: "set",
      definition: {
        id: "compact-manifest-repo",
        name: "Manifest Repo",
        https: "https://example.com/manifest.git",
      },
      baseRevision: "0",
    }],
    changes: [{
      ...publicationInput().changes[0],
      mapping: {
        apps: [{
          appName: "Manifest",
          repos: [{ repoId: "compact-manifest-repo", branch: "main", flavor: "avatr8678" }],
        }],
      },
    }],
  }), { role: "super" });
  const firstDefinition = first.ops.find((op) => op.entityType === "project-definition");
  const firstVehicle = first.ops.find((op) => op.entityType === "vehicle");

  sync.publishVehicleChanges(publicationInput({
    idempotencyKey: "compact-manifest-definition",
    changes: [],
    projectDefs: [{
      id: "compact-manifest-repo",
      action: "set",
      definition: {
        id: "compact-manifest-repo",
        name: "Manifest Repo v2",
        https: "https://example.com/manifest.git",
      },
      baseRevision: firstDefinition.opId,
    }],
  }), { role: "super" });
  db.default.prepare("UPDATE lan_sync_ops SET created_at=1").run();
  sync.pairMember({
    ...sync.localPairingBundle(),
    nodeId: "manifest-peer",
    nodeName: "Manifest Peer",
  });
  const originNodeId = sync.localPairingBundle().nodeId;
  lanStore.updatePeerCursor("manifest-peer", { [originNodeId]: 3 });
  assert.equal(sync.compactLanSyncOperations().deleted, 0);

  sync.publishVehicleChanges(publicationInput({
    idempotencyKey: "compact-manifest-vehicle",
    changes: [{
      ...publicationInput().changes[0],
      mapping: {
        apps: [{
          appName: "Manifest",
          repos: [{
            repoId: "compact-manifest-repo",
            branch: "release/next",
            flavor: "avatr8678",
          }],
        }],
      },
      baseRevision: firstVehicle.opId,
    }],
  }), { role: "super" });
  db.default.prepare("UPDATE lan_sync_ops SET created_at=1").run();
  lanStore.updatePeerCursor("manifest-peer", { [originNodeId]: 4 });
  assert.equal(sync.compactLanSyncOperations().deleted, 2);

  const manifests = db.default.prepare(`
    SELECT change_set_id, COUNT(*) AS actual, MAX(change_set_size) AS declared
    FROM lan_sync_ops
    GROUP BY change_set_id
  `).all();
  assert.ok(manifests.length > 0);
  assert.ok(manifests.every((row) => row.actual === row.declared));
});

test("离线缺口超过 5000 条时可按 version vector 继续取得下一页", () => {
  db.default.exec(`
    WITH RECURSIVE seq(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM seq WHERE value < 5001
    )
    INSERT INTO lan_sync_ops (
      op_id, config_space, change_set_id, change_set_index, change_set_size,
      change_set_hash, origin_node_id, origin_seq, entity_type, entity_key,
      action, base_revision, context_json, hlc, actor_user_id, payload_json,
      payload_hash, schema_version, signature, apply_status, created_at
    )
    SELECT
      'bulk-op-' || value, 'team/test/vehicle-source', 'bulk-set-' || value,
      0, 1, 'manifest', 'bulk-origin', value, 'vehicle',
      'project-a/bulk-' || value, 'delete', '0', '{}',
      '0-' || value || '-bulk-origin', 'test', NULL, 'hash', 1, '',
      'applied', value
    FROM seq;
  `);
  const first = lanStore.listOpsMissingFromVector(
    "team/test/vehicle-source",
    {},
    { limit: 5000 },
  );
  const second = lanStore.listOpsMissingFromVector(
    "team/test/vehicle-source",
    { "bulk-origin": 5000 },
    { limit: 5000 },
  );
  assert.equal(first.length, 5000);
  assert.equal(first.at(-1).originSeq, 5000);
  assert.equal(second.length, 1);
  assert.equal(second[0].originSeq, 5001);
});

test("30 秒 durable range 重试入口可安全执行且不依赖已删除函数", () => {
  assert.doesNotThrow(() => sync.retryConnectedRanges(Date.now() + 30_001));
});

test("对端解决操作可按两个并发 revision 关闭本机对应冲突", () => {
  const conflict = lanStore.createConflict({
    configSpace: "team/test/vehicle-source",
    entityType: "vehicle",
    entityKey: "project-a/avatr8678",
    localRevision: "revision-a",
    remoteRevision: "revision-b",
    localPayload: mapping("release/a"),
    remotePayload: mapping("release/b"),
  });

  const resolved = lanStore.resolveConflictsByRevisions({
    configSpace: "team/test/vehicle-source",
    entityType: "vehicle",
    entityKey: "project-a/avatr8678",
    revisions: ["revision-b", "revision-a"],
    resolvedBy: "remote-admin",
  });

  assert.deepEqual(resolved, [conflict.conflictId]);
  assert.equal(lanStore.getConflict(conflict.conflictId).status, "resolved");
  assert.equal(lanStore.getConflict(conflict.conflictId).resolvedBy, "remote-admin");
});
