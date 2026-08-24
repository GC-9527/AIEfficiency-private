import { hasAdminPermission } from "../../services/adminAuth.js";

export const VEHICLE_SOURCE_CAPABILITIES = Object.freeze({
  read: "vehicle-config:read",
  edit: "vehicle-config:edit",
  publish: "vehicle-config:publish",
  retry: "vehicle-config:retry",
  resolve: "vehicle-config:resolve",
  forceRepair: "vehicle-config:force-repair",
});

export function resolveVehicleSourceAccess(session) {
  return Object.freeze({
    canRead: hasAdminPermission(session, VEHICLE_SOURCE_CAPABILITIES.read),
    canEdit: hasAdminPermission(session, VEHICLE_SOURCE_CAPABILITIES.edit),
    canPublish: hasAdminPermission(session, VEHICLE_SOURCE_CAPABILITIES.publish),
    canRetry: hasAdminPermission(session, VEHICLE_SOURCE_CAPABILITIES.retry),
    canResolve: hasAdminPermission(session, VEHICLE_SOURCE_CAPABILITIES.resolve),
    canForceRepair: hasAdminPermission(session, VEHICLE_SOURCE_CAPABILITIES.forceRepair),
  });
}

export function createVehiclePublicationPreview(data, request, createId) {
  const idempotencyKey = createId();
  return Object.freeze({ ...data, request, idempotencyKey });
}

export function retainUnpublishedFlavors(current, publishedChanges = []) {
  const next = new Set(current || []);
  for (const change of publishedChanges) {
    if (change?.flavor) next.delete(change.flavor);
  }
  return next;
}

export function describeVehiclePublicationTarget(sync = {}) {
  if (String(sync?.sourceMode || "local").trim().toLowerCase() === "center") {
    const host = String(sync?.sourceHost || "").trim();
    return Object.freeze({
      scope: "center",
      heading: "确认发布到车型配置中心",
      draftSuffix: "尚未发布到车型配置中心",
      committedMessage: "已发布到车型配置中心",
      notice: `当前车型配置统一来自 ${host || "已配置的中心 Gateway"}；本机不会再读取旧的本地车型快照。`,
    });
  }
  const mode = String(sync?.syncMode || "disabled").trim().toLowerCase();
  if (mode === "disabled") {
    return Object.freeze({
      scope: "team",
      heading: "确认发布并开启局域网自动同步",
      draftSuffix: "尚未发布到局域网团队",
      committedMessage: "已发布并开启局域网自动同步",
      notice: sync?.transportBlocked
        ? `当前 ${sync?.requestedSyncMode || "peer"} 同步协议不兼容；请修复传输配置后再发布。`
        : "无需设置同步开关。确认本次管理员变更后将自动建立局域网同步，其它 Gateway 自动加入；不会上传它们原有的本机旧配置。",
    });
  }
  if (mode === "receive-only") {
    return Object.freeze({
      scope: "read-only",
      heading: "当前节点只接收团队配置",
      draftSuffix: "当前节点不可发布",
      committedMessage: "",
      notice: "当前为只接收节点，车型配置必须由团队发布节点变更。",
    });
  }
  return Object.freeze({
    scope: "team",
    heading: "确认同步到局域网团队",
    draftSuffix: "尚未同步到局域网团队",
    committedMessage: "已同步到局域网团队",
    notice: "只有本次管理员确认的变更会同步；打开、刷新、启动或发现节点不会发布本机旧配置。",
  });
}

export function describeVehicleSyncConnection(sync = {}) {
  const sourceMode = String(sync?.sourceMode || "local").trim().toLowerCase();
  const sourceHost = String(sync?.sourceHost || "").trim();
  if (sourceMode === "center") {
    return Object.freeze({
      state: "center",
      label: `车型配置中心 · ${sourceHost || "已配置 Gateway"}`,
      detail: "车型配置由独立中心 Gateway 提供。",
      canConnect: false,
    });
  }

  const syncMode = String(sync?.syncMode || "disabled").trim().toLowerCase();
  const members = Array.isArray(sync?.members) ? sync.members : [];
  const connectedPeers = Math.max(0, Number(sync?.connectedPeers) || 0);
  if (connectedPeers > 0) {
    const memberCount = Math.max(members.length, connectedPeers);
    return Object.freeze({
      state: "connected",
      label: `局域网已连接 · ${connectedPeers}/${memberCount} 个成员在线`,
      detail: "车型与仓库定义通过加密 WebSocket 增量同步。",
      canConnect: true,
    });
  }
  if (members.length) {
    const automatic = describeVehicleAutomaticDiscovery(sync);
    return Object.freeze({
      state: "offline",
      label: `局域网成员离线 · 0/${members.length} 个成员在线`,
      detail: automatic.enabled
        ? "已保存成员身份；预置引导节点会在后台持续重连，无需用户重新填写地址。"
        : "已保存成员身份；Gateway 会持续重连，同网段发现不可用时可使用高级恢复。",
      canConnect: true,
    });
  }
  if (syncMode === "peer") {
    const automatic = describeVehicleAutomaticDiscovery(sync);
    return Object.freeze({
      state: "disconnected",
      label: automatic.enabled ? "自动组网中 · 0 个成员" : "局域网未连接 · 0 个成员",
      detail: automatic.detail,
      canConnect: true,
    });
  }
  const automatic = describeVehicleAutomaticDiscovery(sync);
  return Object.freeze({
    state: "waiting",
    label: automatic.enabled ? "等待首次发布 · 自动发现已就绪" : "等待首次管理员发布或局域网发现",
    detail: automatic.detail,
    canConnect: true,
  });
}

export function describeVehicleAutomaticDiscovery(sync = {}) {
  const bootstrap = sync?.discoveryBootstrap || {};
  const enabled = bootstrap.enabled === true && Number(bootstrap.seedCount || 0) > 0;
  const status = String(bootstrap.status || (enabled ? "discovering" : "same-subnet-only"));
  if (!enabled) {
    return Object.freeze({
      enabled: false,
      status: "same-subnet-only",
      label: "同网段自动发现",
      detail: "同一广播域会自动发现；跨子网由部署预置引导节点，普通用户无需输入 Gateway。",
    });
  }
  const labels = {
    connected: "跨子网自动组网已连接",
    joining: "跨子网安全通道建立中",
    retrying: "跨子网自动发现重试中",
    discovering: "跨子网自动发现中",
  };
  return Object.freeze({
    enabled: true,
    status,
    label: labels[status] || labels.discovering,
    detail: `已预置 ${Math.max(1, Number(bootstrap.seedCount) || 0)} 个签名引导节点；Gateway 会在后台发现、校验并重连，无需用户操作。`,
  });
}

export function normalizeVehicleSyncPeerOrigin(value) {
  const input = String(value || "").trim();
  if (!input) return Object.freeze({ ok: false, origin: "", error: "请输入局域网 Gateway 地址" });
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return Object.freeze({ ok: false, origin: "", error: "地址必须是完整的 http(s) origin，例如 http://192.168.10.110:3001" });
  }
  if (!["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash) {
    return Object.freeze({ ok: false, origin: "", error: "地址只能包含 http(s) 协议、主机和端口，不能包含账号、路径、查询或片段" });
  }
  return Object.freeze({ ok: true, origin: parsed.origin, error: "" });
}

function cloneValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function repositoryTuple(repository = {}) {
  return [repository.repoId || repository.projectId, repository.branch, repository.flavor]
    .map((value) => String(value || "").trim())
    .join("\u0000");
}

export function mergeInitialVehiclePresetMapping(current = {}, generated = {}) {
  const merged = cloneValue(current || {}) || {};
  merged.apps = Array.isArray(merged.apps) ? merged.apps : [];
  for (const incomingApplication of Array.isArray(generated?.apps) ? generated.apps : []) {
    const appName = String(incomingApplication?.appName || "").trim();
    let application = merged.apps.find((item) => String(item?.appName || "").trim() === appName);
    if (!application) {
      application = { appName, repos: [] };
      merged.apps.push(application);
    }
    application.repos = Array.isArray(application.repos) ? application.repos : [];
    const tuples = new Set(application.repos.map(repositoryTuple));
    for (const repository of Array.isArray(incomingApplication?.repos) ? incomingApplication.repos : []) {
      const tuple = repositoryTuple(repository);
      if (!tuple || tuples.has(tuple)) continue;
      application.repos.push(cloneValue(repository));
      tuples.add(tuple);
    }
  }
  return merged;
}

/** 只追加扫描候选，不删除、不覆盖当前用户配置，并生成现有团队发布协议的批量请求。 */
export function createInitialVehiclePresetPublicationPlan({
  currentMap = {},
  generatedMap = {},
  configSpace,
  projectId,
  revision,
  entityRevisions = {},
} = {}) {
  const mergedMap = cloneValue(currentMap || {}) || {};
  const changes = [];
  for (const [flavor, generated] of Object.entries(generatedMap || {})) {
    const before = currentMap?.[flavor];
    const mapping = mergeInitialVehiclePresetMapping(before || {}, generated);
    mergedMap[flavor] = mapping;
    if (JSON.stringify(before || null) === JSON.stringify(mapping)) continue;
    changes.push({
      flavor,
      action: "set",
      mapping,
      baseRevision: String(entityRevisions?.[flavor] || "0"),
    });
  }
  return {
    mergedMap,
    changedFlavors: changes.map((change) => change.flavor),
    request: {
      configSpace,
      projectId,
      baseRevision: String(revision || "0"),
      changes,
    },
  };
}
