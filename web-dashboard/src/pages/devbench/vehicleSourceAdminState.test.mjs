import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialVehiclePresetPublicationPlan,
  createVehiclePublicationPreview,
  describeVehicleAutomaticDiscovery,
  describeVehiclePublicationTarget,
  describeVehicleSyncConnection,
  mergeInitialVehiclePresetMapping,
  normalizeVehicleSyncPeerOrigin,
  resolveVehicleSourceAccess,
  retainUnpublishedFlavors,
} from "./vehicleSourceAdminState.mjs";

function session(status, capabilities) {
  return {
    status,
    principal: { role: "admin", name: "测试管理员", capabilities },
    role: "admin",
    permissions: capabilities,
    capabilities,
  };
}

test("车型配置权限只服从共享会话 capability，不受历史父级 false 影响", () => {
  const access = resolveVehicleSourceAccess(session("authenticated", [
    "vehicle-config:read",
    "vehicle-config:edit",
    "vehicle-config:publish",
  ]), false);

  assert.equal(access.canRead, true);
  assert.equal(access.canEdit, true);
  assert.equal(access.canPublish, true);
  assert.equal(access.canResolve, false);
});

test("身份校验降级时保留主体展示，但所有车型修改 capability 立即失败关闭", () => {
  const access = resolveVehicleSourceAccess(session("degraded", [
    "vehicle-config:edit",
    "vehicle-config:publish",
    "vehicle-config:retry",
    "vehicle-config:resolve",
  ]));

  assert.deepEqual(access, {
    canRead: false,
    canEdit: false,
    canPublish: false,
    canRetry: false,
    canResolve: false,
    canForceRepair: false,
  });
});

test("发布一个车型只清理该车型 dirty 状态", () => {
  const remaining = retainUnpublishedFlavors(new Set(["vehicle-a", "vehicle-b"]), [
    { flavor: "vehicle-a", action: "set" },
  ]);

  assert.deepEqual([...remaining], ["vehicle-b"]);
});

test("发布预览生成一次幂等键并在确认阶段稳定复用", () => {
  let calls = 0;
  const preview = createVehiclePublicationPreview(
    { diff: { modified: [{ flavor: "vehicle-a" }] } },
    { changes: [{ flavor: "vehicle-a" }] },
    () => { calls += 1; return "stable-key"; },
  );

  assert.equal(calls, 1);
  assert.equal(preview.idempotencyKey, "stable-key");
  assert.equal(preview.idempotencyKey, "stable-key");
});

test("未启用同步时管理员首次发布会自动建组，不要求额外设置", () => {
  assert.deepEqual(describeVehiclePublicationTarget({ syncMode: "disabled" }), {
    scope: "team",
    heading: "确认发布并开启局域网自动同步",
    draftSuffix: "尚未发布到局域网团队",
    committedMessage: "已发布并开启局域网自动同步",
    notice: "无需设置同步开关。确认本次管理员变更后将自动建立局域网同步，其它 Gateway 自动加入；不会上传它们原有的本机旧配置。",
  });
});

test("peer 与 receive-only 节点保留各自团队发布边界", () => {
  assert.equal(describeVehiclePublicationTarget({ syncMode: "peer" }).scope, "team");
  assert.equal(describeVehiclePublicationTarget({ syncMode: "receive-only" }).scope, "read-only");
});

test("显式车型配置中心优先于中心机自身的同步角色文案", () => {
  assert.deepEqual(describeVehiclePublicationTarget({
    sourceMode: "center",
    sourceHost: "http://192.168.10.110:3001",
    syncMode: "disabled",
  }), {
    scope: "center",
    heading: "确认发布到车型配置中心",
    draftSuffix: "尚未发布到车型配置中心",
    committedMessage: "已发布到车型配置中心",
    notice: "当前车型配置统一来自 http://192.168.10.110:3001；本机不会再读取旧的本地车型快照。",
  });
});

test("peer 模式使用预置引导节点时明确显示后台自动组网", () => {
  assert.deepEqual(describeVehicleSyncConnection({
    syncMode: "peer",
    members: [],
    connectedPeers: 0,
    discoveryBootstrap: { enabled: true, status: "retrying", seedCount: 1 },
  }), {
    state: "disconnected",
    label: "自动组网中 · 0 个成员",
    detail: "已预置 1 个签名引导节点；Gateway 会在后台发现、校验并重连，无需用户操作。",
    canConnect: true,
  });
});

test("跨子网自动发现文案区分预置引导和同网段降级", () => {
  assert.deepEqual(describeVehicleAutomaticDiscovery({
    discoveryBootstrap: { enabled: true, status: "connected", seedCount: 2 },
  }), {
    enabled: true,
    status: "connected",
    label: "跨子网自动组网已连接",
    detail: "已预置 2 个签名引导节点；Gateway 会在后台发现、校验并重连，无需用户操作。",
  });
  const fallback = describeVehicleAutomaticDiscovery({});
  assert.equal(fallback.enabled, false);
  assert.equal(fallback.status, "same-subnet-only");
  assert.match(fallback.detail, /普通用户无需输入 Gateway/);
});

test("车型同步连接状态区分在线、离线成员和显式中心", () => {
  assert.equal(describeVehicleSyncConnection({
    syncMode: "peer",
    members: [{ nodeId: "a", online: true }, { nodeId: "b", online: false }],
    connectedPeers: 1,
  }).label, "局域网已连接 · 1/2 个成员在线");
  assert.equal(describeVehicleSyncConnection({
    syncMode: "peer",
    members: [{ nodeId: "a", online: false }],
    connectedPeers: 0,
  }).state, "offline");
  assert.equal(describeVehicleSyncConnection({
    sourceMode: "center",
    sourceHost: "http://192.168.10.110:3001",
  }).label, "车型配置中心 · http://192.168.10.110:3001");
});

test("跨子网车型 Gateway 只接受无凭据、无路径的 http(s) origin", () => {
  assert.deepEqual(normalizeVehicleSyncPeerOrigin(" http://192.168.10.110:3001/ "), {
    ok: true,
    origin: "http://192.168.10.110:3001",
    error: "",
  });
  for (const input of [
    "192.168.10.110:3001",
    "ftp://192.168.10.110:3001",
    "http://admin:secret@192.168.10.110:3001",
    "http://192.168.10.110:3001/api/config",
    "http://192.168.10.110:3001?token=x",
  ]) {
    const result = normalizeVehicleSyncPeerOrigin(input);
    assert.equal(result.ok, false, input);
    assert.equal(result.origin, "", input);
    assert.ok(result.error, input);
  }
});

test("旧协议兼容阻断时只提示修复传输，不引导人工建组", () => {
  const target = describeVehiclePublicationTarget({
    syncMode: "disabled",
    requestedSyncMode: "peer",
    transportBlocked: true,
  });
  assert.match(target.notice, /协议不兼容/);
  assert.match(target.notice, /修复传输配置/);
});

test("peer 发布明确提示只有管理员确认的变更会同步", () => {
  const target = describeVehiclePublicationTarget({ syncMode: "peer" });
  assert.equal(target.heading, "确认同步到局域网团队");
  assert.match(target.notice, /打开、刷新、启动或发现节点不会发布/);
});

test("初始预置只追加远程扫描 tuple，不覆盖用户自定义字段和映射", () => {
  const merged = mergeInitialVehiclePresetMapping({
    prodReleaseDir: "\\\\share\\car-a",
    needsResign: true,
    apps: [{
      appName: "应用市场",
      repos: [{ repoId: "custom", branch: "manual", flavor: "car-a" }],
    }],
  }, {
    apps: [{
      appName: "应用市场",
      repos: [
        { repoId: "appMarket", branch: "release/car-a", flavor: "car-a" },
        { repoId: "appMarket", branch: "release/car-a", flavor: "car-a" },
        { repoId: "appMarket", branch: "release/Car-A", flavor: "car-a" },
      ],
    }],
  });

  assert.equal(merged.prodReleaseDir, "\\\\share\\car-a");
  assert.equal(merged.needsResign, true);
  assert.deepEqual(merged.apps[0].repos, [
    { repoId: "custom", branch: "manual", flavor: "car-a" },
    { repoId: "appMarket", branch: "release/car-a", flavor: "car-a" },
    { repoId: "appMarket", branch: "release/Car-A", flavor: "car-a" },
  ]);
});

test("初始预置批量请求保留现有车型并只提交有追加变化的车型", () => {
  const current = {
    carA: {
      prodReleaseDir: "D:/release/carA",
      apps: [{ appName: "应用市场", repos: [{ repoId: "appMarket", branch: "release/a", flavor: "carA" }] }],
    },
    manualOnly: {
      apps: [{ appName: "天气", repos: [{ repoId: "weather", branch: "main", flavor: "manualOnly" }] }],
    },
  };
  const plan = createInitialVehiclePresetPublicationPlan({
    currentMap: current,
    generatedMap: {
      carA: { apps: [{ appName: "应用市场", repos: [{ repoId: "appMarket", branch: "release/a", flavor: "carA" }] }] },
      carB: { apps: [{ appName: "应用市场", repos: [{ repoId: "appMarket", branch: "v202605-ui", flavor: "carB" }] }] },
    },
    configSpace: "team-a",
    projectId: "project-a",
    revision: 12,
    entityRevisions: { carB: "7" },
  });

  assert.deepEqual(plan.changedFlavors, ["carB"]);
  assert.deepEqual(plan.mergedMap.manualOnly, current.manualOnly);
  assert.equal(plan.request.configSpace, "team-a");
  assert.equal(plan.request.baseRevision, "12");
  assert.equal(plan.request.changes[0].baseRevision, "7");
});
