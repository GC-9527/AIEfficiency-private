import { createHash, randomUUID } from "node:crypto";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_RESERVATION_TTL_MS = 60 * 60 * 1000;
const intents = new Map();

const text = (value) => String(value ?? "").trim();
const list = (value) => (Array.isArray(value) ? value : []);
const clone = (value) => JSON.parse(JSON.stringify(value));

function unique(values) {
  return [...new Set(list(values).map(text).filter(Boolean))];
}

function sourceTargetId(repositoryId, branch) {
  const identity = `${text(repositoryId).toLowerCase()}\u0000${text(branch)}`;
  return `source_${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

function normalizedVehicleSelections(value) {
  const seen = new Set();
  return list(value).flatMap((selection) => {
    const vehicle = text(selection?.vehicle);
    if (!vehicle) return [];
    const appNames = unique(selection?.appNames);
    const key = `${vehicle.toLowerCase()}\u0000${appNames.map((name) => name.toLowerCase()).sort().join("\u0000")}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ vehicle, appNames }];
  });
}

/**
 * 把“车型 + 应用”高层选择解析为不可歧义的源码目标。
 *
 * 同仓库同分支只准备一次基仓，并保留全部车型/应用消费者；同仓库不同分支
 * 必须生成不同 targetId。服务端只从 vehicleMap 读取仓库与分支，不能信任
 * 浏览器提交的展开结果。legacyEntries 仅用于兼容旧故事点/旧客户端。
 */
export function resolveVehicleSourceTargets({
  vehicleSelections = [],
  legacyEntries = [],
  projectDefId = "",
} = {}, {
  vehicleMap = {},
  projectDefs = [],
} = {}) {
  const selections = normalizedVehicleSelections(vehicleSelections);
  const definitionMap = new Map(list(projectDefs).map((definition) => [text(definition?.id), definition]));
  const targets = new Map();

  const addTarget = (repo = {}, consumer = {}, fallbackRole = "") => {
    const repositoryId = text(repo.repoId || repo.repositoryId || repo.projectId);
    const branch = text(repo.branch);
    if (!repositoryId) return {
      ok: false,
      statusCode: 400,
      code: "STORY_SOURCE_REPOSITORY_REQUIRED",
      error: `车型「${consumer.vehicle || "未命名"}」的应用「${consumer.appName || "未命名"}」缺少仓库定义`,
    };
    const definition = definitionMap.get(repositoryId);
    if (!definition) return {
      ok: false,
      statusCode: 400,
      code: "STORY_SOURCE_REPOSITORY_INVALID",
      error: `车型源码配置引用了不存在的仓库「${repositoryId}」`,
    };
    if (!branch) return {
      ok: false,
      statusCode: 400,
      code: "STORY_SOURCE_BRANCH_REQUIRED",
      error: `车型「${consumer.vehicle || "未命名"}」的应用「${consumer.appName || definition.name || repositoryId}」未配置分支`,
    };
    const key = `${repositoryId.toLowerCase()}\u0000${branch}`;
    const normalizedConsumer = {
      vehicle: text(consumer.vehicle),
      appName: text(consumer.appName),
      flavor: text(repo.flavor || consumer.flavor || consumer.vehicle),
    };
    const existing = targets.get(key);
    if (existing) {
      const consumerKey = JSON.stringify(normalizedConsumer);
      if (!existing.consumers.some((item) => JSON.stringify(item) === consumerKey)) {
        existing.consumers.push(normalizedConsumer);
      }
      if (!existing.targetRole && text(repo.targetRole || fallbackRole)) {
        existing.targetRole = text(repo.targetRole || fallbackRole);
      }
      return { ok: true };
    }
    targets.set(key, {
      targetId: sourceTargetId(repositoryId, branch),
      projectId: repositoryId,
      repositoryId,
      branch,
      flavor: normalizedConsumer.flavor,
      vehicle: normalizedConsumer.vehicle,
      appName: normalizedConsumer.appName,
      consumers: [normalizedConsumer],
      projectType: text(repo.projectType || definition.projectType || "application"),
      targetRole: text(repo.targetRole || fallbackRole),
      order: Number(repo.order) > 0 ? Math.trunc(Number(repo.order)) : 0,
    });
    return { ok: true };
  };

  if (selections.length) {
    for (const selection of selections) {
      const mapping = vehicleMap && typeof vehicleMap === "object" ? vehicleMap[selection.vehicle] : null;
      if (!mapping || typeof mapping !== "object") return {
        ok: false,
        statusCode: 400,
        code: "STORY_SOURCE_VEHICLE_INVALID",
        error: `车型「${selection.vehicle}」没有可用的源码配置`,
      };
      const apps = list(mapping.apps).filter((app) => app && typeof app === "object");
      if (!selection.appNames.length) return {
        ok: false,
        statusCode: 400,
        code: "STORY_SOURCE_APPLICATION_REQUIRED",
        error: `请为车型「${selection.vehicle}」至少选择一个应用`,
      };
      const selectedApps = selection.appNames
        .map((appName) => apps.find((app) => text(app?.appName) === appName));
      const missingAppIndex = selectedApps.findIndex((app) => !app);
      if (missingAppIndex >= 0) return {
        ok: false,
        statusCode: 400,
        code: "STORY_SOURCE_APPLICATION_INVALID",
        error: `车型「${selection.vehicle}」没有应用「${selection.appNames[missingAppIndex]}」`,
      };
      if (!selectedApps.length) return {
        ok: false,
        statusCode: 400,
        code: "STORY_SOURCE_APPLICATION_REQUIRED",
        error: `车型「${selection.vehicle}」尚未配置应用源码`,
      };
      for (const app of selectedApps) {
        for (const repo of list(app?.repos)) {
          const added = addTarget(repo, {
            vehicle: selection.vehicle,
            appName: text(app?.appName),
            flavor: text(repo?.flavor || selection.vehicle),
          });
          if (!added.ok) return added;
        }
      }
    }
  } else {
    for (const entry of list(legacyEntries)) {
      if (!entry || !text(entry.projectId || entry.repositoryId)) continue;
      const added = addTarget(entry, {
        vehicle: text(entry.vehicle),
        appName: text(entry.appName),
        flavor: text(entry.flavor),
      }, text(entry.targetRole));
      if (!added.ok) return added;
    }
  }

  const entries = [...targets.values()].sort((left, right) => (
    (left.order || Number.MAX_SAFE_INTEGER) - (right.order || Number.MAX_SAFE_INTEGER)
  ));
  if (!entries.length) return {
    ok: false,
    statusCode: 400,
    code: "STORY_SOURCE_TARGETS_REQUIRED",
    error: "请至少选择一个已配置源码仓库的车型应用",
  };
  const requestedPrimary = text(projectDefId);
  let primaryIndex = entries.findIndex((entry) => entry.repositoryId === requestedPrimary);
  if (primaryIndex < 0) primaryIndex = entries.findIndex((entry) => ["primary", "standalone"].includes(text(entry.targetRole).toLowerCase()));
  if (primaryIndex < 0) primaryIndex = 0;
  entries.forEach((entry, index) => {
    entry.targetRole = index === primaryIndex ? "primary" : (text(entry.targetRole).toLowerCase() === "webapp" ? "webapp" : "dependency");
  });
  return {
    ok: true,
    projectDefId: entries[primaryIndex].repositoryId,
    vehicleSelections: selections,
    entries,
  };
}

const PROJECT_CONFLICT_DIMENSIONS = new Set([
  "appname",
  "application",
  "applicationrepository",
  "project",
  "repository",
  "repositoryid",
]);

function normalizedValue(value) {
  return text(value).toLowerCase();
}

function projectCandidateValues(project = {}) {
  return unique([
    project.id,
    project.repositoryId,
    project.repoId,
    project.projectDefId,
    project.name,
    project.projectName,
    project.repositoryName,
    project.appName,
    project.applicationName,
    project.ssh,
    project.https,
    project.url,
  ]).map(normalizedValue);
}

function selectedProjectForSnapshot(snapshot, projects, projectDefs) {
  if (snapshot.mode === "local") {
    return list(projects).find((project) => text(project?.id) === text(snapshot.primaryProjectId)) || null;
  }
  if (snapshot.mode === "remote") {
    return list(projectDefs).find((project) => text(project?.id) === text(snapshot.projectDefId)) || null;
  }
  return null;
}

function primaryRemoteEntry(snapshot) {
  const entries = list(snapshot?.remotePull?.entries);
  return entries.find((entry) => text(entry?.projectId) === text(snapshot?.projectDefId)) || entries[0] || null;
}

function localPrimaryFlavor(snapshot, projects) {
  const primary = list(projects).find((project) => text(project?.id) === text(snapshot?.primaryProjectId));
  const primaryPath = normalizedValue(primary?.path);
  if (!primaryPath) return "";
  const row = list(snapshot?.flavors).find((item) => normalizedValue(item?.path) === primaryPath);
  return text(row?.flavor);
}

function snapshotConflictValue(snapshot, dimension, projects, projectDefs) {
  if (dimension === "vehicle") {
    return snapshot.mode === "remote" ? text(snapshot?.remotePull?.vehicle) : "";
  }
  if (dimension === "branch") {
    return snapshot.mode === "remote" ? text(primaryRemoteEntry(snapshot)?.branch) : "";
  }
  if (dimension === "flavor") {
    return snapshot.mode === "remote"
      ? text(primaryRemoteEntry(snapshot)?.flavor)
      : snapshot.mode === "local" ? localPrimaryFlavor(snapshot, projects) : "";
  }
  if (PROJECT_CONFLICT_DIMENSIONS.has(dimension)) {
    return text(snapshot.mode === "remote" ? snapshot.projectDefId : snapshot.primaryProjectId);
  }
  return "";
}

function manualConflictValue(snapshot, dimension, projects, projectDefs) {
  const value = snapshotConflictValue(snapshot, dimension, projects, projectDefs);
  if (value) return value;
  if (dimension === "vehicle") return "当前面板未设置车型";
  if (dimension === "branch") return "当前面板未设置分支";
  if (dimension === "flavor") return "当前面板未设置 Flavor";
  if (PROJECT_CONFLICT_DIMENSIONS.has(dimension)) return "当前面板未设置主工程";
  return "以当前面板配置为准";
}

function validConflictResolution(item, resolution, { snapshot, projects, projectDefs }) {
  if (!resolution || typeof resolution !== "object") return false;
  const rawDimension = text(item?.dimension);
  const dimension = normalizedValue(rawDimension);
  if (!dimension || text(resolution.dimension) !== rawDimension) return false;
  const selection = text(resolution.selection);
  const value = text(resolution.value);
  if (selection === "manual") {
    return value === manualConflictValue(snapshot, dimension, projects, projectDefs);
  }
  if (!selection.startsWith("candidate:")) return false;
  const selectedValue = selection.slice("candidate:".length).trim();
  if (!selectedValue || selectedValue !== value) return false;
  const declaredCandidate = list(item?.candidates).some((candidate) => (
    text(candidate && typeof candidate === "object" ? candidate.value : candidate) === selectedValue
  ));
  if (!declaredCandidate) return false;
  if (["vehicle", "branch", "flavor"].includes(dimension)) {
    return snapshotConflictValue(snapshot, dimension, projects, projectDefs) === selectedValue;
  }
  if (PROJECT_CONFLICT_DIMENSIONS.has(dimension)) {
    const selectedProject = selectedProjectForSnapshot(snapshot, projects, projectDefs);
    if (!selectedProject) return false;
    const expected = normalizedValue(selectedValue);
    const rows = snapshot.mode === "remote" ? list(projectDefs) : list(projects);
    const matches = rows.filter((project) => projectCandidateValues(project).includes(expected));
    return matches.length === 1 && text(matches[0]?.id) === text(selectedProject.id);
  }
  return false;
}

function fingerprint(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function cleanupExpired(now = Date.now()) {
  for (const [id, intent] of intents) {
    const deadline = intent.state === "reserved"
      ? intent.reservationExpiresAt
      : intent.expiresAt;
    if (deadline <= now) intents.delete(id);
  }
}

export function normalizeStoryInitialization(input = {}, {
  projects = [],
  projectDefs = [],
  vehicleMap = {},
  titleTaken = () => null,
} = {}) {
  const title = text(input.title);
  if (!title) return { ok: false, statusCode: 400, code: "STORY_TITLE_REQUIRED", error: "请先设置故事点标题" };
  const duplicate = titleTaken(title);
  if (duplicate) {
    return {
      ok: false,
      statusCode: 409,
      code: "STORY_TITLE_TAKEN",
      error: `标题「${title}」已被${duplicate.where || "其它故事点"}占用，请改个名`,
    };
  }

  const mode = ["blank", "local", "remote"].includes(input.mode) ? input.mode : "blank";
  const projectMap = new Map(list(projects).map((project) => [text(project?.id), project]));
  const definitionMap = new Map(list(projectDefs).map((definition) => [text(definition?.id), definition]));
  const deviceSerial = text(input.deviceSerial);
  let snapshot = { mode: "blank", deviceSerial: deviceSerial || null };

  if (mode === "local") {
    const primaryProjectId = text(input.primaryProjectId);
    const primary = projectMap.get(primaryProjectId);
    if (!primary) {
      return { ok: false, statusCode: 400, code: "STORY_PRIMARY_PROJECT_REQUIRED", error: "请选择有效的本地主工程" };
    }
    if (primary.exists === false) {
      return { ok: false, statusCode: 400, code: "STORY_PRIMARY_PROJECT_UNAVAILABLE", error: "本地主工程路径不可用" };
    }
    const extraProjectIds = unique(input.extraProjectIds).filter((id) => id !== primaryProjectId);
    const unknownExtra = extraProjectIds.find((id) => !projectMap.has(id));
    if (unknownExtra) {
      return { ok: false, statusCode: 400, code: "STORY_EXTRA_PROJECT_INVALID", error: `关联工程「${unknownExtra}」不存在` };
    }
    const baseExtraProjects = extraProjectIds.map((id) => {
      const project = projectMap.get(id);
      return {
        path: project.path,
        basePath: project.path,
        baseProjectId: project.id,
        name: project.name || project.id,
      };
    });
    const flavors = list(input.flavors).flatMap((row) => {
      const project = projectMap.get(text(row?.projectId));
      const flavor = text(row?.flavor);
      return project?.path && flavor ? [{ path: project.path, flavor }] : [];
    });
    snapshot = {
      mode: "local",
      primaryProjectId,
      basePrimaryProjectId: primaryProjectId,
      baseExtraProjects,
      flavors,
      deviceSerial: deviceSerial || null,
      ...(input.configInference && typeof input.configInference === "object"
        ? { configInference: clone(input.configInference) }
        : {}),
    };
  } else if (mode === "remote") {
    const requestedProjectDefId = text(input.projectDefId);
    const legacyEntries = list(input.remotePull?.entries);
    const sourceTargets = resolveVehicleSourceTargets({
      vehicleSelections: input.remotePull?.vehicleSelections || input.vehicleSelections,
      legacyEntries,
      projectDefId: requestedProjectDefId,
    }, { vehicleMap, projectDefs });
    if (!sourceTargets.ok) return sourceTargets;
    const projectDefId = sourceTargets.projectDefId;
    if (!definitionMap.has(projectDefId)) {
      return { ok: false, statusCode: 400, code: "STORY_REMOTE_PROJECT_REQUIRED", error: "请选择有效的远程主工程" };
    }
    const remoteProjectDefIds = unique(sourceTargets.entries.map((entry) => entry.repositoryId || entry.projectId));
    const firstSelection = sourceTargets.vehicleSelections[0];
    snapshot = {
      mode: "remote",
      projectDefId,
      primaryProjectId: null,
      deviceSerial: deviceSerial || null,
      remotePull: {
        sourcePlanVersion: 2,
        tbProjectId: text(input.tbProjectId || input.remotePull?.tbProjectId),
        vehicle: text(firstSelection?.vehicle || input.remotePull?.vehicle),
        vehicleSelections: clone(sourceTargets.vehicleSelections),
        tbId: text(input.remotePull?.tbId),
        entries: clone(sourceTargets.entries),
      },
    };
  }

  const conflicts = list(input.conflicts).filter((item) => item?.resolutionRequired !== false);
  const resolutions = input.conflictResolutions && typeof input.conflictResolutions === "object"
    ? clone(input.conflictResolutions)
    : {};
  const unresolved = conflicts.filter((item) => !validConflictResolution(
    item,
    resolutions[text(item?.id)],
    { snapshot, projects, projectDefs },
  ));
  if (unresolved.length) {
    return {
      ok: false,
      statusCode: 409,
      code: "STORY_SOURCE_CONFLICT_UNRESOLVED",
      error: `仍有 ${unresolved.length} 项来源矛盾未裁决，不能确认创建`,
      conflicts: unresolved.map((item) => ({ id: text(item?.id), dimension: text(item?.dimension) })),
    };
  }

  return {
    ok: true,
    data: {
      title,
      ticketInput: text(input.ticketInput),
      sourceLabel: text(input.sourceLabel) || "手动创建",
      entry: input.entry && typeof input.entry === "object" ? clone(input.entry) : { kind: "manual" },
      snapshot,
      conflictResolutions: resolutions,
    },
  };
}

export function issueStoryInitializationIntent(payload, {
  ownerKey = "anonymous",
  consumer = "tabs",
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  cleanupExpired(now);
  const normalized = clone(payload);
  const id = randomUUID();
  const intent = {
    id,
    ownerKey: text(ownerKey) || "anonymous",
    consumer: text(consumer) || "tabs",
    payload: normalized,
    fingerprint: fingerprint(normalized),
    state: "ready",
    createdAt: now,
    expiresAt: now + Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS),
  };
  intents.set(id, intent);
  return clone(intent);
}

function missingIntentResult() {
  return {
    ok: false,
    statusCode: 409,
    code: "STORY_INITIALIZATION_EXPIRED",
    error: "故事点初始化确认已过期或已使用，请重新检查配置后确认",
  };
}

function ownerMismatchResult() {
  return {
    ok: false,
    statusCode: 403,
    code: "STORY_INITIALIZATION_OWNER_MISMATCH",
    error: "故事点初始化确认不属于当前用户，请重新打开配置面板",
  };
}

export function reserveStoryInitializationIntent(id, {
  ownerKey = "anonymous",
  consumer = "tabs",
  now = Date.now(),
  reservationTtlMs = DEFAULT_RESERVATION_TTL_MS,
} = {}) {
  cleanupExpired(now);
  const key = text(id);
  const intent = intents.get(key);
  if (!intent) return missingIntentResult();
  if (intent.ownerKey !== (text(ownerKey) || "anonymous")) {
    return ownerMismatchResult();
  }
  if (intent.consumer !== (text(consumer) || "tabs")) {
    return {
      ok: false,
      statusCode: 409,
      code: "STORY_INITIALIZATION_CONSUMER_MISMATCH",
      error: "该初始化确认不属于当前创建入口，请返回原入口重新确认",
    };
  }
  if (intent.state === "committed") {
    return {
      ok: true,
      replay: true,
      committed: true,
      data: clone(intent.payload),
      fingerprint: intent.fingerprint,
      result: clone(intent.result),
    };
  }
  if (intent.state === "reserved") {
    return {
      ok: false,
      statusCode: 409,
      code: "STORY_INITIALIZATION_IN_PROGRESS",
      error: "该初始化确认正在创建故事点，请等待当前请求完成",
    };
  }
  const reservationId = randomUUID();
  intent.state = "reserved";
  intent.reservationId = reservationId;
  intent.reservedAt = now;
  intent.reservationExpiresAt = now + Math.max(1000, Number(reservationTtlMs) || DEFAULT_RESERVATION_TTL_MS);
  return {
    ok: true,
    replay: false,
    reservationId,
    data: clone(intent.payload),
    fingerprint: intent.fingerprint,
  };
}

export function commitStoryInitializationIntent(id, {
  ownerKey = "anonymous",
  reservationId,
  result,
  now = Date.now(),
  replayTtlMs = DEFAULT_TTL_MS,
} = {}) {
  const key = text(id);
  const intent = intents.get(key);
  if (!intent) return missingIntentResult();
  if (intent.ownerKey !== (text(ownerKey) || "anonymous")) return ownerMismatchResult();
  if (intent.state === "committed") {
    return { ok: true, replay: true, result: clone(intent.result) };
  }
  if (intent.state !== "reserved" || intent.reservationId !== text(reservationId)) {
    return {
      ok: false,
      statusCode: 409,
      code: "STORY_INITIALIZATION_RESERVATION_MISMATCH",
      error: "初始化确认的创建租约已变化，拒绝写入不确定的创建结果",
    };
  }
  intent.state = "committed";
  intent.result = clone(result);
  intent.committedAt = now;
  intent.expiresAt = now + Math.max(1000, Number(replayTtlMs) || DEFAULT_TTL_MS);
  delete intent.reservationId;
  delete intent.reservedAt;
  delete intent.reservationExpiresAt;
  return { ok: true, replay: false, result: clone(intent.result) };
}

export function releaseStoryInitializationIntent(id, {
  ownerKey = "anonymous",
  reservationId,
  now = Date.now(),
  retryTtlMs = DEFAULT_TTL_MS,
} = {}) {
  const key = text(id);
  const intent = intents.get(key);
  if (!intent) return missingIntentResult();
  if (intent.ownerKey !== (text(ownerKey) || "anonymous")) return ownerMismatchResult();
  if (intent.state === "committed") {
    return { ok: true, committed: true, result: clone(intent.result) };
  }
  if (intent.state !== "reserved" || intent.reservationId !== text(reservationId)) {
    return {
      ok: false,
      statusCode: 409,
      code: "STORY_INITIALIZATION_RESERVATION_MISMATCH",
      error: "初始化确认的创建租约已变化，无法安全释放",
    };
  }
  intent.state = "ready";
  intent.expiresAt = now + Math.max(1000, Number(retryTtlMs) || DEFAULT_TTL_MS);
  delete intent.reservationId;
  delete intent.reservedAt;
  delete intent.reservationExpiresAt;
  return { ok: true };
}

export function clearStoryInitializationIntentsForTest() {
  intents.clear();
}
