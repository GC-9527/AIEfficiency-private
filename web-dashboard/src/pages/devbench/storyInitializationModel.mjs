const text = (value) => String(value ?? "").trim();
const list = (value) => (Array.isArray(value) ? value : []);

function readableSummaryScalar(value) {
  if (!["string", "number", "boolean"].includes(typeof value)) return "";
  const normalized = String(value).trim();
  return normalized === "[object Object]" ? "" : normalized;
}

function inferenceRepositoryName(repository) {
  const scalar = readableSummaryScalar(repository);
  if (scalar) return scalar;
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) return "";
  return readableSummaryScalar(
    repository.projectName
      || repository.repositoryName
      || repository.repositoryId
      || repository.name,
  );
}

function inferenceTargetSummary(target) {
  const scalar = readableSummaryScalar(target);
  if (scalar) return scalar;
  if (!target || typeof target !== "object" || Array.isArray(target)) return "";
  const repositories = (Array.isArray(target.repositories)
    ? target.repositories
    : target.repositories ? [target.repositories] : [])
    .map(inferenceRepositoryName)
    .filter(Boolean);
  const repository = readableSummaryScalar(target.projectName)
    || repositories[0]
    || readableSummaryScalar(target.repositoryName || target.repositoryId || target.appName || target.name);
  const vehicle = readableSummaryScalar(target.vehicle);
  const branch = readableSummaryScalar(target.branch);
  const flavor = readableSummaryScalar(target.flavor);
  const variant = [vehicle, branch, flavor].filter(Boolean).join(" / ");
  const explicitExtras = (Array.isArray(target.extras)
    ? target.extras
    : target.extras ? [target.extras] : [])
    .map(inferenceRepositoryName)
    .filter(Boolean);
  const extras = [...new Set((explicitExtras.length ? explicitExtras : repositories.slice(1))
    .filter((item) => item !== repository))];
  if (!repository) {
    const inferredFields = [
      vehicle ? `车型：${vehicle}` : "",
      branch ? `分支：${branch}` : "",
      flavor ? `Flavor：${flavor}` : "",
    ].filter(Boolean);
    if (extras.length) inferredFields.push(`关联工程：${extras.join("、")}`);
    return inferredFields.length ? `${inferredFields.join(" / ")}（主工程待人工确认）` : "";
  }
  const primary = variant ? `${repository}（${variant}）` : repository;
  return extras.length ? `${primary}；关联工程：${extras.join("、")}` : primary;
}

function inferenceSummaryValue(value, depth = 0) {
  if (depth > 4) return "";
  const scalar = readableSummaryScalar(value);
  if (scalar) return scalar;
  if (Array.isArray(value)) {
    return value.map((item) => inferenceSummaryValue(item, depth + 1)).filter(Boolean).join("；");
  }
  if (!value || typeof value !== "object") return "";

  for (const key of ["summary", "reasoning", "explanation"]) {
    const direct = inferenceSummaryValue(value[key], depth + 1);
    if (direct) return direct;
  }

  const targets = Array.isArray(value.targets)
    ? value.targets
    : value.targets ? [value.targets] : [];
  const targetText = targets.map(inferenceTargetSummary).filter(Boolean).join("、");
  if (targetText) return `建议 ${targetText}`;

  const missing = Array.isArray(value.missingInformation)
    ? value.missingInformation
    : value.missingInformation ? [value.missingInformation] : [];
  const missingText = missing
    .map((item) => inferenceSummaryValue(item, depth + 1))
    .filter(Boolean)
    .slice(0, 3)
    .join("；");
  if (missingText) return missingText;

  if (["projectName", "repositories", "extras", "repositoryName", "repositoryId", "appName", "vehicle", "branch", "flavor"]
    .some((key) => value[key] != null)) {
    return inferenceTargetSummary(value);
  }
  return "";
}

export function storyInitializationInferenceSummaryText(inferenceSummary, inference = null) {
  return inferenceSummaryValue(inferenceSummary)
    || inferenceSummaryValue(inference)
    || "本入口没有可展示的推理摘要，请按当前面板信息人工确认。";
}

function normPath(value) {
  return text(value).replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

function unique(values) {
  return [...new Set(list(values).map(text).filter(Boolean))];
}

/** 车型源码配置只能复用于同一个 TB 项目；切换项目时旧对象必须立即失效。 */
export function storyVehicleSourceConfigForProject(requestedProjectId, loadedProjectId, config) {
  const requested = text(requestedProjectId);
  const loaded = text(loadedProjectId);
  if (!requested || requested !== loaded) return null;
  return config && typeof config === "object" && !Array.isArray(config) ? config : null;
}

/** 已选工程按主工程/关联工程的选择顺序置顶，未选项保持原始顺序且不修改入参。 */
export function orderStoryInitializationProjects(items = [], selectedIds = []) {
  const rows = list(items);
  const byId = new Map(rows.map((item) => [text(item?.id), item]));
  const selected = unique(selectedIds).map((id) => byId.get(id)).filter(Boolean);
  const selectedSet = new Set(selected.map((item) => text(item?.id)));
  return [...selected, ...rows.filter((item) => !selectedSet.has(text(item?.id)))];
}

function normalizedProjectSearchValue(value) {
  return text(value).replace(/\\/g, "/").toLocaleLowerCase();
}

/** 本机工程搜索统一匹配工程名/标识、实时 Git 分支和完整路径，支持多关键词与路径分隔符兼容。 */
export function filterStoryInitializationProjects(items = [], query = "") {
  const rows = list(items);
  const keywords = normalizedProjectSearchValue(query).split(/\s+/).filter(Boolean);
  if (!keywords.length) return [...rows];
  return rows.filter((project) => {
    const searchable = [
      project?.name,
      project?.id,
      project?.branch,
      project?.path,
    ].map(normalizedProjectSearchValue).join("\u0000");
    return keywords.every((keyword) => searchable.includes(keyword));
  });
}

/** 本机工程在初始化面板中的实时 Git 分支、当前故事点 Flavor 与目录路径。 */
export function storyInitializationProjectRuntimeStatus(project = {}, flavorByProjectId = {}) {
  const projectId = text(project?.id);
  const branch = text(project?.branch);
  const flavor = text(flavorByProjectId && typeof flavorByProjectId === "object"
    ? flavorByProjectId[projectId]
    : "");
  const path = text(project?.path);
  return {
    branch,
    flavor,
    path,
    branchLabel: branch || (project?.exists === false ? "路径不可用" : "未检测到"),
    flavorLabel: flavor || "未指定",
    pathLabel: path || (project?.exists === false ? "路径不可用" : "本机路径未返回"),
  };
}

/** 配置面板的 AS 入口属于“本机工程”，只能打开工程登记的基础路径。 */
export function storyInitializationStudioPath(project = {}) {
  return text(project?.path);
}

export function normalizeStoryVehicleSelections(value) {
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

/** 浏览器侧只用于预览；最终仓库/分支必须由服务端按 vehicleMap 再解析。 */
export function storyVehicleSourcePreview(vehicleSelections, vehicleMap = {}, projectDefs = []) {
  const selections = normalizeStoryVehicleSelections(vehicleSelections);
  const definitionIds = new Set(list(projectDefs).map((definition) => text(definition?.id)));
  const targets = new Map();
  const errors = [];
  for (const selection of selections) {
    const mapping = vehicleMap?.[selection.vehicle];
    if (!mapping) {
      errors.push(`车型「${selection.vehicle}」没有源码配置`);
      continue;
    }
    const apps = list(mapping.apps);
    if (!selection.appNames.length) {
      errors.push(`请为车型「${selection.vehicle}」至少选择一个应用`);
      continue;
    }
    for (const appName of selection.appNames) {
      const app = apps.find((item) => text(item?.appName) === appName);
      if (!app) {
        errors.push(`车型「${selection.vehicle}」没有应用「${appName}」`);
        continue;
      }
      for (const repo of list(app?.repos)) {
        const projectId = text(repo?.repoId || repo?.projectId);
        const branch = text(repo?.branch);
        if (!projectId || !definitionIds.has(projectId)) {
          errors.push(`应用「${appName}」引用了无效仓库「${projectId || "未配置"}」`);
          continue;
        }
        if (!branch) {
          errors.push(`应用「${appName}」的仓库「${projectId}」未配置分支`);
          continue;
        }
        const key = `${projectId.toLowerCase()}\u0000${branch}`;
        const consumer = { vehicle: selection.vehicle, appName, flavor: text(repo?.flavor || selection.vehicle) };
        const current = targets.get(key);
        if (current) {
          current.consumers.push(consumer);
          continue;
        }
        targets.set(key, {
          targetKey: key,
          projectId,
          repositoryId: projectId,
          branch,
          flavor: consumer.flavor,
          vehicle: selection.vehicle,
          appName,
          consumers: [consumer],
          targetRole: text(repo?.targetRole),
          order: Number(repo?.order) > 0 ? Math.trunc(Number(repo.order)) : 0,
        });
      }
    }
  }
  const entries = [...targets.values()].sort((left, right) => (
    (left.order || Number.MAX_SAFE_INTEGER) - (right.order || Number.MAX_SAFE_INTEGER)
  ));
  let primaryIndex = entries.findIndex((entry) => ["primary", "standalone"].includes(text(entry.targetRole).toLowerCase()));
  if (primaryIndex < 0) primaryIndex = 0;
  entries.forEach((entry, index) => {
    entry.targetRole = index === primaryIndex ? "primary" : (text(entry.targetRole).toLowerCase() === "webapp" ? "webapp" : "dependency");
  });
  return {
    ok: selections.length > 0 && errors.length === 0 && entries.length > 0,
    selections,
    entries,
    projectDefId: entries[primaryIndex]?.projectId || "",
    errors,
  };
}

function localProjectRepositoryIndex(projectApplications = []) {
  const byProjectId = new Map();
  for (const application of list(projectApplications)) {
    const applicationName = text(application?.name || application?.appName);
    for (const repository of list(application?.repositories)) {
      const repositoryId = text(repository?.repositoryId || repository?.repoId);
      if (!repositoryId) continue;
      for (const projectId of unique(repository?.projectIds)) {
        const current = byProjectId.get(projectId) || { repositoryIds: [], applicationNames: [] };
        current.repositoryIds = unique([...current.repositoryIds, repositoryId]);
        current.applicationNames = unique([...current.applicationNames, applicationName]);
        byProjectId.set(projectId, current);
      }
    }
  }
  return byProjectId;
}

function localFlavorTargetCategory(entry, definition) {
  if (entry?.targetRole === "primary") return "primary";
  if (entry?.targetRole === "webapp"
    || ["repository", "sdk", "tooling", "service"].includes(text(definition?.projectType).toLowerCase())) return "common";
  return "related";
}

function localFlavorTarget(entry, definition, localProjects, vehicle, { optional = false } = {}) {
  const repositoryId = text(entry?.repositoryId || definition?.id);
  const branch = text(entry?.branch || definition?.defaultBranch);
  const category = localFlavorTargetCategory(entry, definition);
  const candidates = localProjects.filter((project) => list(project.repositoryIds).includes(repositoryId));
  const exactCandidates = candidates.filter((project) => (
    project?.exists !== false && (!branch || text(project?.branch) === branch)
  ));
  const status = exactCandidates.length === 1
    ? "ready"
    : exactCandidates.length > 1
      ? "ambiguous"
      : candidates.length
        ? "branch_mismatch"
        : "unconfigured";
  return {
    ...entry,
    repositoryId,
    branch,
    selectionKey: `${vehicle}\u0000${entry?.targetKey || `common:${repositoryId}`}`,
    repositoryName: text(definition?.name || definition?.id || repositoryId),
    projectType: text(definition?.projectType || "application"),
    category,
    optional,
    independentFlavor: category === "common",
    candidates,
    exactCandidates,
    status,
    autoProjectId: !optional && exactCandidates.length === 1 ? text(exactCandidates[0]?.id) : "",
  };
}

/**
 * 把共享车型源码配置动态投影到本机 schema v4 applications + 实时 Git 分支。
 * 不持久化第二份 Flavor 映射：保存本机工程或切换分支后，重新加载输入即可得到新结果。
 */
export function storyLocalFlavorMappingOptions({
  vehicleMap = {},
  projectDefs = [],
  projects = [],
  projectApplications = [],
} = {}) {
  const projectRelations = localProjectRepositoryIndex(projectApplications);
  const definitions = new Map(list(projectDefs).map((definition) => [text(definition?.id), definition]));
  const localProjects = list(projects).map((project) => {
    const relation = projectRelations.get(text(project?.id)) || {};
    return {
      ...project,
      repositoryIds: unique([project?.repositoryId, ...list(project?.repositoryIds), ...list(relation.repositoryIds)]),
      applicationNames: unique([...list(project?.applicationNames), ...list(relation.applicationNames)]),
    };
  });

  return Object.entries(vehicleMap && typeof vehicleMap === "object" ? vehicleMap : {})
    .map(([vehicle, mapping]) => {
      const appNames = unique(list(mapping?.apps).map((application) => application?.appName));
      const preview = storyVehicleSourcePreview([{ vehicle, appNames }], vehicleMap, projectDefs);
      const mappedTargets = preview.entries.map((entry) => {
        const definition = definitions.get(entry.repositoryId) || {};
        return localFlavorTarget(entry, definition, localProjects, vehicle);
      });
      const mappedRepositoryIds = new Set(mappedTargets.map((target) => target.repositoryId));
      const commonTargets = list(projectDefs)
        .filter((definition) => (
          ["repository", "sdk", "tooling", "service"].includes(text(definition?.projectType).toLowerCase())
          && !mappedRepositoryIds.has(text(definition?.id))
        ))
        .map((definition) => localFlavorTarget({
          appName: "",
          vehicle: text(vehicle),
          repositoryId: text(definition?.id),
          targetKey: `common:${text(definition?.id)}`,
          targetRole: text(definition?.inferenceRole || "dependency"),
          repositoryOnly: true,
          branch: text(definition?.defaultBranch),
          flavor: text(definition?.defaultFlavor),
          consumers: [],
        }, definition, localProjects, vehicle, { optional: true }));
      const targets = [...mappedTargets, ...commonTargets];
      return {
        vehicle: text(vehicle),
        appNames,
        flavors: unique(mappedTargets.map((target) => target.flavor)),
        targets,
        sourceErrors: [...preview.errors],
      };
    })
    .filter((option) => option.vehicle && option.targets.length)
    .sort((left, right) => left.vehicle.localeCompare(right.vehicle));
}

/** 解析自动唯一命中与用户对多 checkout 的显式选择；分支不匹配的工程不能被强行应用。 */
export function storyLocalFlavorMappingResolution(option = null, selections = {}, flavorSelections = {}) {
  if (!option || !Array.isArray(option.targets)) {
    return { ok: false, targets: [], errors: ["请选择车型 / Flavor"] };
  }
  const selectedFlavors = new Map();
  const errors = [...list(option.sourceErrors)];
  const targets = option.targets.map((target) => {
    const requestedProjectId = text(selections?.[target.selectionKey]);
    const selectedProject = target.exactCandidates.find((project) => text(project?.id) === requestedProjectId)
      || (!target.optional && target.exactCandidates.length === 1 ? target.exactCandidates[0] : null);
    if (!selectedProject) {
      if (requestedProjectId) errors.push(`仓库「${target.repositoryName}」选择的本机工程与目标分支不匹配`);
      else if (!target.optional) {
        if (target.status === "ambiguous") errors.push(`仓库「${target.repositoryName}」在分支「${target.branch}」有多个本机工程，请明确选择`);
        else if (target.status === "branch_mismatch") errors.push(`仓库「${target.repositoryName}」没有位于分支「${target.branch}」的本机工程`);
        else errors.push(`仓库「${target.repositoryName}」尚未配置本机工程`);
      }
    } else {
      const projectId = text(selectedProject.id);
      const availableFlavors = unique(selectedProject?.flavors);
      const requestedFlavor = text(flavorSelections?.[target.selectionKey]);
      let selectedFlavor = text(target.flavor);
      if (target.independentFlavor) {
        if (requestedFlavor && availableFlavors.length && !availableFlavors.includes(requestedFlavor)) {
          errors.push(`本机工程「${text(selectedProject.name || selectedProject.id)}」不包含 Flavor「${requestedFlavor}」`);
        }
        selectedFlavor = requestedFlavor
          || (selectedFlavor && (!availableFlavors.length || availableFlavors.includes(selectedFlavor)) ? selectedFlavor : "")
          || (availableFlavors.length === 1 ? availableFlavors[0] : "");
      }
      const currentFlavor = selectedFlavors.get(projectId);
      if (currentFlavor && selectedFlavor && currentFlavor !== selectedFlavor) {
        errors.push(`本机工程「${text(selectedProject.name || selectedProject.id)}」被映射到多个不同 Flavor`);
      } else if (selectedFlavor) {
        selectedFlavors.set(projectId, selectedFlavor);
      }
      return { ...target, selectedProject, selectedFlavor, availableFlavors };
    }
    return { ...target, selectedProject, selectedFlavor: "", availableFlavors: [] };
  });
  const primary = targets.find((target) => target.category === "primary");
  if (!primary?.selectedProject) errors.push("当前映射没有可用的本机主工程");
  return { ok: errors.length === 0, targets, errors: unique(errors) };
}

/** 将已完全解析的本机 Flavor 映射一次性写入初始化草稿，不留下旧工程的 Flavor 残值。 */
export function applyStoryLocalFlavorMapping(draft = {}, option = null, selections = {}, flavorSelections = {}) {
  const resolution = storyLocalFlavorMappingResolution(option, selections, flavorSelections);
  if (!resolution.ok) return { ok: false, draft: { ...draft }, resolution, error: resolution.errors[0] };
  const primary = resolution.targets.find((target) => target.category === "primary");
  const primaryProjectId = text(primary?.selectedProject?.id);
  const selectedTargets = resolution.targets.filter((target) => target.selectedProject);
  const flavorByProjectId = Object.fromEntries(selectedTargets
    .map((target) => [text(target.selectedProject.id), text(target.selectedFlavor)])
    .filter(([projectId, flavor]) => projectId && flavor));
  return {
    ok: true,
    resolution,
    draft: {
      ...draft,
      mode: "local",
      primaryProjectId,
      extraProjectIds: unique(selectedTargets.map((target) => target.selectedProject.id))
        .filter((projectId) => projectId !== primaryProjectId),
      flavorByProjectId,
    },
  };
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]),
  );
}

export function storyInitializationIntentRequestFingerprint(request = {}) {
  return JSON.stringify(stableJsonValue(request));
}

export function canReuseStoryInitializationIntent(preparedIntent = null, requestFingerprint = "") {
  return !!preparedIntent?.id
    && !!preparedIntent?.fingerprint
    && text(preparedIntent.requestFingerprint) === text(requestFingerprint);
}

const INVALID_STORY_INITIALIZATION_INTENT_CODES = new Set([
  "STORY_INITIALIZATION_EXPIRED",
  "STORY_INITIALIZATION_OWNER_MISMATCH",
  "STORY_INITIALIZATION_CONSUMER_MISMATCH",
  "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH",
]);

const STORY_INITIALIZATION_INFERENCE_REFRESH_CODES = new Set([
  "STORY_CREATE_AI_REVIEW_REQUIRED",
  "STORY_CREATE_AI_REVIEW_OWNER_MISMATCH",
  "STORY_CREATE_AI_REVIEW_PROJECT_MISMATCH",
  "STORY_CREATE_AI_REVIEW_TRIGGER_MISMATCH",
  "STORY_CREATE_AI_REVIEW_CONSUMER_MISMATCH",
  "STORY_CREATE_AI_REVIEW_SCOPE_INVALID",
  "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH",
  "STORY_CREATE_AI_REVIEW_EXPIRED",
  "STORY_CREATE_AI_REVIEW_STALE",
]);

export function shouldDiscardStoryInitializationIntent(result = null) {
  if (!result || result.ok !== false || result.partial === true) return false;
  return INVALID_STORY_INITIALIZATION_INTENT_CODES.has(text(result.code).toUpperCase());
}

export function storyInitializationRequiresInferenceRefresh(result = null) {
  if (!result || result.ok !== false || result.partial === true) return false;
  return STORY_INITIALIZATION_INFERENCE_REFRESH_CODES.has(text(result.code).toUpperCase());
}

function normalizedValue(value) {
  return text(value).toLowerCase();
}

const PROJECT_CONFLICT_DIMENSIONS = new Set([
  "appname",
  "application",
  "applicationrepository",
  "project",
  "repository",
  "repositoryid",
]);

const SHARED_CONFIGURATION_CONFLICT_DIMENSIONS = new Set([
  ...PROJECT_CONFLICT_DIMENSIONS,
  "mode",
  "vehicle",
  "branch",
  "flavor",
  "device",
  "deviceserial",
]);

export function isStoryInitializationSharedConfigurationConflict(conflict = {}) {
  return SHARED_CONFIGURATION_CONFLICT_DIMENSIONS.has(normalizedValue(
    conflict.dimension || conflict.field || conflict.key,
  ));
}

/**
 * 组成员只能独立确认标题与 TB 身份；工程、构建和设备必须继承组锚/首项的真实配置。
 * 该函数同时用于面板展示和最终提交，避免仅靠 disabled 控件形成可绕过的视觉锁。
 */
export function applyStoryInitializationSharedConfiguration(draft = {}, sharedDraft = null) {
  if (!sharedDraft || typeof sharedDraft !== "object") return { ...draft };
  return {
    ...draft,
    mode: sharedDraft.mode,
    primaryProjectId: text(sharedDraft.primaryProjectId),
    extraProjectIds: unique(sharedDraft.extraProjectIds),
    projectDefId: text(sharedDraft.projectDefId),
    remoteProjectDefIds: unique(sharedDraft.remoteProjectDefIds),
    vehicle: text(sharedDraft.vehicle),
    branch: text(sharedDraft.branch),
    remoteFlavor: text(sharedDraft.remoteFlavor),
    flavorByProjectId: { ...(sharedDraft.flavorByProjectId || {}) },
    deviceSerial: text(sharedDraft.deviceSerial),
  };
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

function uniqueProjectCandidate(rows, candidateValue) {
  const expected = normalizedValue(candidateValue);
  if (!expected) return { ok: false, reason: "empty" };
  const matches = list(rows).filter((row) => projectCandidateValues(row).includes(expected));
  if (matches.length !== 1) {
    return { ok: false, reason: matches.length ? "ambiguous" : "missing" };
  }
  return { ok: true, project: matches[0] };
}

function manualConflictValue(draft, dimension) {
  if (dimension === "vehicle") return text(draft.vehicle) || "当前面板未设置车型";
  if (dimension === "branch") return text(draft.branch) || "当前面板未设置分支";
  if (dimension === "flavor") {
    if (draft.mode === "remote") return text(draft.remoteFlavor) || "当前面板未设置 Flavor";
    if (draft.mode === "local") {
      return text(draft.flavorByProjectId?.[text(draft.primaryProjectId)]) || "当前面板未设置 Flavor";
    }
    return "当前面板未设置 Flavor";
  }
  if (PROJECT_CONFLICT_DIMENSIONS.has(dimension)) {
    return text(draft.mode === "remote" ? draft.projectDefId : draft.primaryProjectId) || "当前面板未设置主工程";
  }
  return "以当前面板配置为准";
}

function conflictMappingError(label, value, detail) {
  const candidate = text(value) ? `“${text(value)}”` : "该候选";
  return `${label}候选 ${candidate}${detail}。请先在对应配置页人工设置，再选择“以当前面板配置为准”`;
}

/**
 * 把来源冲突裁决落实到初始化草稿。候选值只有在能唯一映射到最终配置字段时才算已裁决；
 * 无法可靠映射时返回错误，避免 UI 只勾选单选框却仍使用另一套工程配置。
 */
export function applyStoryInitializationConflictResolution(
  draft = {},
  conflict = {},
  decision = {},
  { projects = [], projectDefs = [] } = {},
) {
  const rawDimension = text(conflict.dimension || conflict.field || conflict.key);
  const dimension = normalizedValue(rawDimension);
  const selection = text(decision.selection);
  const selectedValue = text(
    decision.value || (selection.startsWith("candidate:") ? selection.slice("candidate:".length) : ""),
  );
  const current = { ...draft };

  if (!rawDimension) {
    return { ok: false, draft: current, error: "该来源矛盾缺少配置维度，无法可靠应用" };
  }
  if (selection === "manual") {
    return {
      ok: true,
      draft: current,
      appliedFields: [],
      resolution: {
        dimension: rawDimension,
        selection: "manual",
        value: manualConflictValue(current, dimension),
      },
    };
  }
  if (!selection.startsWith("candidate:") || !selectedValue) {
    return { ok: false, draft: current, error: "请选择一个有效候选，或以当前面板配置为准" };
  }

  const resolution = {
    dimension: rawDimension,
    selection: `candidate:${selectedValue}`,
    value: selectedValue,
  };
  if (dimension === "vehicle" || dimension === "branch") {
    if (current.mode !== "remote") {
      return {
        ok: false,
        draft: current,
        error: conflictMappingError(dimension === "vehicle" ? "车型" : "分支", selectedValue, "仅能应用到远程工程模式"),
      };
    }
    const field = dimension;
    return {
      ok: true,
      draft: { ...current, [field]: selectedValue },
      appliedFields: [field],
      resolution,
    };
  }

  if (dimension === "flavor") {
    if (current.mode === "remote") {
      return {
        ok: true,
        draft: { ...current, remoteFlavor: selectedValue },
        appliedFields: ["remoteFlavor"],
        resolution,
      };
    }
    if (current.mode === "local" && text(current.primaryProjectId)) {
      return {
        ok: true,
        draft: {
          ...current,
          flavorByProjectId: {
            ...(current.flavorByProjectId || {}),
            [text(current.primaryProjectId)]: selectedValue,
          },
        },
        appliedFields: [`flavorByProjectId.${text(current.primaryProjectId)}`],
        resolution,
      };
    }
    return {
      ok: false,
      draft: current,
      error: conflictMappingError("Flavor", selectedValue, "没有可承载该值的主工程"),
    };
  }

  if (PROJECT_CONFLICT_DIMENSIONS.has(dimension)) {
    if (current.mode === "local") {
      const matched = uniqueProjectCandidate(projects, selectedValue);
      if (!matched.ok || matched.project?.exists === false) {
        const detail = matched.reason === "ambiguous"
          ? "匹配到多个本机工程"
          : matched.project?.exists === false ? "对应本机工程路径不可用" : "无法唯一匹配本机工程";
        return { ok: false, draft: current, error: conflictMappingError("主工程", selectedValue, detail) };
      }
      const projectId = text(matched.project.id);
      return {
        ok: true,
        draft: {
          ...current,
          primaryProjectId: projectId,
          extraProjectIds: unique(current.extraProjectIds).filter((id) => id !== projectId),
        },
        appliedFields: ["primaryProjectId"],
        resolution,
      };
    }
    if (current.mode === "remote") {
      const matched = uniqueProjectCandidate(projectDefs, selectedValue);
      if (!matched.ok) {
        const detail = matched.reason === "ambiguous" ? "匹配到多个远程工程定义" : "无法唯一匹配远程工程定义";
        return { ok: false, draft: current, error: conflictMappingError("主工程", selectedValue, detail) };
      }
      const projectDefId = text(matched.project.id);
      return {
        ok: true,
        draft: {
          ...current,
          projectDefId,
          remoteProjectDefIds: unique(current.remoteProjectDefIds).filter((id) => id !== projectDefId),
        },
        appliedFields: ["projectDefId"],
        resolution,
      };
    }
    return {
      ok: false,
      draft: current,
      error: conflictMappingError("主工程", selectedValue, "在空白模式下无法判断应使用本机还是远程工程"),
    };
  }

  return {
    ok: false,
    draft: current,
    error: conflictMappingError(rawDimension, selectedValue, "暂时没有可靠的字段映射"),
  };
}

function mappedDraftValue(draft, field) {
  if (field.startsWith("flavorByProjectId.")) {
    return text(draft.flavorByProjectId?.[field.slice("flavorByProjectId.".length)]);
  }
  return text(draft[field]);
}

/** 已选候选必须仍与面板当前配置一致；用户后续手改字段时需重新裁决。 */
export function storyInitializationConflictResolutionMatchesDraft(
  draft = {},
  conflict = {},
  resolution = null,
  context = {},
) {
  if (!resolution || typeof resolution !== "object") return false;
  if (text(resolution.selection) === "manual") {
    const dimension = normalizedValue(conflict.dimension || conflict.field || conflict.key);
    return text(resolution.value) === manualConflictValue(draft, dimension);
  }
  const applied = applyStoryInitializationConflictResolution(draft, conflict, resolution, context);
  if (!applied.ok || !applied.appliedFields?.length) return false;
  return applied.appliedFields.every((field) => (
    mappedDraftValue(draft, field) === mappedDraftValue(applied.draft, field)
  ));
}

function projectByPath(projects, value) {
  const key = normPath(value);
  return key ? list(projects).find((project) => normPath(project?.path) === key) || null : null;
}

function projectIdForEntry(projects, entry = {}) {
  return text(
    entry.baseProjectId
      || entry.projectId
      || projectByPath(projects, entry.basePath || entry.path)?.id,
  );
}

function basePathForFlavor(projects, worktreeEntries, value) {
  const key = normPath(value);
  if (!key) return "";
  const managed = list(worktreeEntries).find((entry) => (
    normPath(entry?.path || entry?.worktreePath) === key
      || normPath(entry?.basePath) === key
  ));
  return text(managed?.basePath || projectByPath(projects, value)?.path || value);
}

function flavorMapFromSnapshot(snapshot = {}, projects = [], tab = {}) {
  const entries = list(snapshot?.worktree?.entries).length
    ? snapshot.worktree.entries
    : list(tab?.worktree?.entries);
  const out = {};
  for (const row of list(snapshot?.flavors).length ? snapshot.flavors : list(tab?.flavors)) {
    // 优先使用可移植的 projectId（备份还原时后端 flavors 只有 { projectId, flavor }，
    // 没有 path；按 path 匹配会全部落空导致 Flavor 丢失），回退按 path 匹配本机工程。
    const explicitProjectId = text(row?.projectId || row?.baseProjectId);
    const matchedProject = explicitProjectId
      ? list(projects).find((project) => text(project?.id) === explicitProjectId)
      : null;
    const basePath = (matchedProject && matchedProject.path)
      || basePathForFlavor(projects, entries, row?.path);
    const project = matchedProject || projectByPath(projects, basePath);
    const projectId = text(
      project?.id
      || explicitProjectId
      || entries.find((entry) => normPath(entry?.basePath) === normPath(basePath))?.baseProjectId,
    );
    if (projectId && text(row?.flavor)) out[projectId] = text(row.flavor);
  }
  return out;
}

function inferredPrimaryProjectId(snapshot = {}, tab = {}, projects = []) {
  const worktree = list(snapshot?.worktree?.entries).length ? snapshot.worktree : tab?.worktree;
  const primary = list(worktree?.entries).find((entry) => entry?.role === "primary");
  return text(
    snapshot?.basePrimaryProjectId
      || snapshot?.primaryProjectId
      || primary?.baseProjectId
      || tab?.primaryProjectId
      || projectByPath(projects, primary?.basePath)?.id,
  );
}

function inferredExtraProjectIds(snapshot = {}, tab = {}, projects = []) {
  const explicit = list(snapshot?.baseExtraProjects).length
    ? snapshot.baseExtraProjects
    : list(snapshot?.extraProjects).length
      ? snapshot.extraProjects
      : list(tab?.worktree?.entries).filter((entry) => entry?.role === "extra").length
        ? list(tab.worktree.entries).filter((entry) => entry?.role === "extra")
        : list(tab?.extraProjects);
  return unique(explicit.map((entry) => projectIdForEntry(projects, entry)));
}

export const STORY_INITIALIZATION_TABS = Object.freeze([
  { id: "identity", label: "故事点信息" },
  { id: "projects", label: "工程范围" },
  { id: "build", label: "构建与设备" },
  { id: "review", label: "确认创建" },
]);

export function storyInitializationTabsForMode(mode = "create") {
  if (mode !== "edit") return STORY_INITIALIZATION_TABS.map((item) => ({ ...item }));
  return [
    ...STORY_INITIALIZATION_TABS.slice(0, 3).map((item) => ({ ...item })),
    { id: "workflow_archive", label: "工作流与归档" },
    { ...STORY_INITIALIZATION_TABS[3], label: "确认更新" },
  ];
}

export function storyInitializationPrimaryAction(mode = "create", activeTab = "identity") {
  if (mode === "edit") return "confirm";
  return activeTab === "review" ? "confirm" : "next";
}

export function storyInitializationConfirmAction({
  canConfirm = true,
  partialRecovery = false,
} = {}) {
  return canConfirm && !partialRecovery ? "confirm" : "blocked";
}

export function createStoryInitializationDraft({
  body = {},
  task = null,
  snapshot = null,
  tab = null,
  projects = [],
  projectDefs = [],
  sourceLabel = "手动创建",
} = {}) {
  const config = snapshot && typeof snapshot === "object" ? snapshot : {};
  const current = tab && typeof tab === "object" ? tab : {};
  const primaryProjectId = inferredPrimaryProjectId(config, current, projects);
  const remotePull = config.remotePull || current.remotePull || {};
  const mode = config.mode === "remote" || current.mode === "remote"
    ? "remote"
    : primaryProjectId ? "local" : "blank";
  const projectDefId = text(config.projectDefId || current.projectDefId || body.projectDefId);
  const remoteEntry = list(remotePull.entries).find((entry) => (
    !projectDefId || text(entry?.projectId) === projectDefId
  )) || list(remotePull.entries)[0] || {};
  const ticketInput = text(
    body.ticketInput
      || body.ticketUrl
      || task?.ticketUrl
      || task?.ticketId
      || task?.carbId
      || current.ticketUrl,
  );
  const title = text(body.title || task?.storyTitle || task?.title || current.title);
  const validProjectDefId = projectDefId || text(projectDefs[0]?.id);
  const vehicleSelections = normalizeStoryVehicleSelections(
    remotePull.vehicleSelections?.length
      ? remotePull.vehicleSelections
      : remotePull.vehicle ? [{
        vehicle: remotePull.vehicle,
        appNames: unique(list(remotePull.entries).map((entry) => entry?.appName)),
      }] : [],
  );
  return {
    title,
    ticketInput,
    mode,
    sourceLabel: text(sourceLabel) || "手动创建",
    primaryProjectId,
    extraProjectIds: inferredExtraProjectIds(config, current, projects)
      .filter((id) => id !== primaryProjectId),
    projectDefId: validProjectDefId,
    remoteProjectDefIds: unique(list(remotePull.entries).map((entry) => entry?.projectId))
      .filter((id) => id !== validProjectDefId),
    tbProjectId: text(task?.projectId || task?._projectId || remotePull.tbProjectId || body.tbProjectId),
    vehicleSelections,
    vehicleSourceEntries: list(remotePull.entries).map((entry) => ({ ...entry })),
    vehicle: text(remotePull.vehicle),
    branch: text(remoteEntry.branch),
    remoteFlavor: text(remoteEntry.flavor),
    flavorByProjectId: flavorMapFromSnapshot(config, projects, current),
    deviceSerial: text(config.deviceSerial || current.deviceSerial),
    inference: config.configInference || null,
    reportMode: current.reportMode === "expert" ? "expert" : "short",
    archiveMode: text(current.archiveDir) ? "custom" : "default",
    archiveDir: text(current.archiveDir || current.effectiveArchiveDir || current.defaultArchiveDir),
    effectiveArchiveDir: text(current.effectiveArchiveDir || current.archiveDir || current.defaultArchiveDir),
    defaultArchiveDir: text(current.defaultArchiveDir),
    rejectedArchiveDir: text(current.rejectedArchiveDir),
    archiveFile: text(current.archiveFile),
    storyStorageRoot: text(current.storyStorageRoot),
    storyStorageDirectory: text(current.storyStorageDirectory),
    attachmentDir: text(current.attachmentDir),
    reportsDir: text(current.reportsDir),
    tempDir: text(current.tempDir),
    scriptsDir: text(current.scriptsDir),
  };
}

export function storyConfigurationSnapshotForEditing(snapshot = {}) {
  const current = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : {};
  const planned = current.plannedInitializationSnapshot;
  if (current.workspaceInitialization?.status !== "error"
    || !planned
    || typeof planned !== "object"
    || Array.isArray(planned)) return current;
  return {
    ...current,
    ...planned,
    sourceTabId: current.sourceTabId,
    sourceTitle: current.sourceTitle,
    worktree: current.worktree,
    workspaceInitialization: current.workspaceInitialization,
    plannedInitializationSnapshot: planned,
  };
}

export function storyWorkspaceInitializationPendingIds(tabs = []) {
  const pendingWorkspaceStatuses = new Set(["queued", "preparing"]);
  const pendingRemoteStatuses = new Set(["queued", "cloning"]);
  return unique(list(tabs).flatMap((tab) => {
    const workspaceStatus = text(tab?.workspaceInitialization?.status).toLowerCase();
    const worktreeStatus = text(tab?.worktreeStatus).toLowerCase();
    const remoteStatus = text(tab?.remoteSourceInitialization?.status).toLowerCase();
    const cloneStatus = text(tab?.cloneStatus).toLowerCase();
    const pending = pendingWorkspaceStatuses.has(workspaceStatus)
      || pendingWorkspaceStatuses.has(worktreeStatus)
      || pendingRemoteStatuses.has(remoteStatus)
      || pendingRemoteStatuses.has(cloneStatus);
    const id = text(tab?.id);
    return pending && id ? [id] : [];
  }));
}

export function mergeRemoteCloneProgress(current = null, payload = {}) {
  let previous = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : { repos: {}, status: "cloning" };
  const currentGeneration = Number(previous.generation);
  const incomingGeneration = Number(payload?.generation);
  if (Number.isFinite(currentGeneration) && Number.isFinite(incomingGeneration)) {
    if (incomingGeneration < currentGeneration) return previous;
    if (incomingGeneration > currentGeneration) previous = { repos: {}, status: "cloning" };
  } else if (previous.operationId && payload?.operationId && previous.operationId !== payload.operationId) {
    return previous;
  }
  const repos = previous.repos && typeof previous.repos === "object" && !Array.isArray(previous.repos)
    ? { ...previous.repos }
    : {};
  const { tabId: _ignoredTabId, repo, done, ...patch } = payload && typeof payload === "object" ? payload : {};
  if (repo === "__all__") {
    return {
      ...previous,
      ...patch,
      repos,
      ...(done ? { done: true } : {}),
    };
  }
  if (!text(repo)) return { ...previous, repos };
  repos[repo] = { ...(repos[repo] || {}), ...patch };
  return { ...previous, repos };
}

function finiteProgress(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

export function remoteSourceInitializationProgress(tab = {}, cloneProgress = null) {
  const candidates = [
    finiteProgress(cloneProgress?.percent),
    finiteProgress(tab?.remoteSourceInitialization?.progress),
  ].filter((value) => value !== null);
  if (candidates.length) return Math.round(Math.max(...candidates));
  const repositoryRows = Object.values(cloneProgress?.repos || {}).filter(Boolean);
  if (repositoryRows.length) {
    return Math.round(repositoryRows.reduce((sum, row) => sum + (finiteProgress(row?.percent) || 0), 0) / repositoryRows.length);
  }
  return tab?.cloneStatus === "cloning" ? 20 : 5;
}

export function validateStoryInitializationDraft(draft = {}, {
  existingTitles = [],
  currentTitle = "",
  projects = [],
  projectDefs = [],
} = {}) {
  const errors = {};
  const title = text(draft.title);
  const taken = new Set(list(existingTitles).map(text).filter((value) => value && value !== text(currentTitle)));
  if (!title) errors.title = "请输入故事点标题";
  else if (taken.has(title)) errors.title = "标题已存在，请换一个标题";
  if (draft.mode === "local") {
    const primary = list(projects).find((project) => text(project?.id) === text(draft.primaryProjectId));
    if (!primary) errors.primaryProjectId = "请选择主工程";
    else if (primary.exists === false) errors.primaryProjectId = "主工程本地路径不可用";
  }
  if (draft.mode === "remote") {
    const vehicleSelections = normalizeStoryVehicleSelections(draft.vehicleSelections);
    if (vehicleSelections.length) {
      if (vehicleSelections.some((selection) => !selection.appNames.length)) {
        errors.vehicleSelections = "每个车型至少选择一个应用";
      }
      if (!list(draft.vehicleSourceEntries).length) {
        errors.vehicleSelections = errors.vehicleSelections || "所选车型应用没有可准备的源码仓库";
      }
      return { ok: Object.keys(errors).length === 0, errors };
    }
    const definition = list(projectDefs).find((item) => text(item?.id) === text(draft.projectDefId));
    if (!definition) errors.projectDefId = "请选择远程主工程";
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

export function storyInitializationConfig(draft = {}) {
  const mode = ["local", "remote", "blank"].includes(draft.mode) ? draft.mode : "blank";
  const primaryProjectId = text(draft.primaryProjectId);
  const projectDefId = text(draft.projectDefId);
  const extraProjectIds = unique(draft.extraProjectIds).filter((id) => id !== primaryProjectId);
  const flavors = Object.entries(draft.flavorByProjectId || {})
    .map(([projectId, flavor]) => ({ projectId: text(projectId), flavor: text(flavor) }))
    .filter((row) => row.projectId && row.flavor);
  if (mode === "remote") {
    const vehicleSelections = normalizeStoryVehicleSelections(draft.vehicleSelections);
    if (vehicleSelections.length) {
      const entries = list(draft.vehicleSourceEntries).map((entry) => ({
        ...entry,
        projectId: text(entry?.projectId || entry?.repositoryId),
        branch: text(entry?.branch),
        flavor: text(entry?.flavor),
      })).filter((entry) => entry.projectId && entry.branch);
      const resolvedProjectDefId = text(draft.projectDefId)
        || text(entries.find((entry) => entry.targetRole === "primary")?.projectId)
        || text(entries[0]?.projectId);
      return {
        mode: "remote",
        tbProjectId: text(draft.tbProjectId),
        projectDefId: resolvedProjectDefId,
        deviceSerial: text(draft.deviceSerial),
        remotePull: {
          sourcePlanVersion: 2,
          tbProjectId: text(draft.tbProjectId),
          vehicle: vehicleSelections[0]?.vehicle || "",
          vehicleSelections,
          tbId: text(draft.ticketInput).match(/\bCARB-\d+\b/i)?.[0]?.toUpperCase() || "",
          entries,
        },
      };
    }
    const remoteIds = unique([projectDefId, ...list(draft.remoteProjectDefIds)]);
    return {
      mode: "remote",
      projectDefId,
      deviceSerial: text(draft.deviceSerial),
      remotePull: {
        vehicle: text(draft.vehicle),
        tbId: text(draft.ticketInput).match(/\bCARB-\d+\b/i)?.[0]?.toUpperCase() || "",
        entries: remoteIds.map((id) => ({
          projectId: id,
          branch: text(draft.branch),
          flavor: text(draft.remoteFlavor || draft.vehicle),
        })),
      },
    };
  }
  if (mode === "local") {
    return {
      mode: "local",
      primaryProjectId,
      extraProjectIds,
      flavors,
      deviceSerial: text(draft.deviceSerial),
      ...(draft.inference ? { configInference: draft.inference } : {}),
    };
  }
  return { mode: "blank", deviceSerial: text(draft.deviceSerial) };
}

export function storyInitializationInferenceRequest({
  session = null,
  projectId = "",
  localProjectBindings = [],
} = {}) {
  // 创建证明只能来自本次入口显式完成并保存人工复核的 session。
  // 配置快照可能来自被复制的旧故事点或组锚，不能把其中的历史 run 当成本次创建授权。
  const runId = text(session?.id);
  if (!runId) return null;
  return {
    runId,
    projectId: text(session?.projectId || session?.ticket?.projectId || projectId),
    localProjectBindings: list(localProjectBindings),
  };
}

export function storyConfigurationSnapshot(draft = {}, projects = []) {
  const config = storyInitializationConfig(draft);
  if (config.mode !== "local") return config;
  const primary = list(projects).find((project) => text(project?.id) === config.primaryProjectId);
  const extras = config.extraProjectIds
    .map((id) => list(projects).find((project) => text(project?.id) === id))
    .filter(Boolean)
    .map((project) => ({
      path: project.path,
      basePath: project.path,
      baseProjectId: project.id,
      name: project.name || project.id,
    }));
  const flavors = config.flavors.flatMap((row) => {
    const project = list(projects).find((item) => text(item?.id) === row.projectId);
    return project?.path ? [{ path: project.path, flavor: row.flavor }] : [];
  });
  return {
    mode: "local",
    primaryProjectId: primary?.id || config.primaryProjectId,
    basePrimaryProjectId: primary?.id || config.primaryProjectId,
    baseExtraProjects: extras,
    flavors,
    deviceSerial: config.deviceSerial || null,
    ...(config.configInference ? { configInference: config.configInference } : {}),
  };
}
