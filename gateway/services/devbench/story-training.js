const ROUTER_VERSION = "story-router-rules-v1";
const REGISTRY_VERSION = "engineering-registry-v1";

export const STORY_TRAINING_ENVIRONMENTS = ["dev", "test", "staging", "prod"];
export const STORY_TRAINING_BUILD_TYPES = ["debug", "release"];

function allowedDimension(value, allowed) {
  const normalized = stringValue(value, 80).toLowerCase();
  return allowed.includes(normalized) ? normalized : "";
}

function timestampValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

const HARD_FIELDS = [
  ["commitSha", ["commitSha", "commit", "sha"], 34, "提交 SHA"],
  ["buildNumber", ["buildNumber", "jenkinsBuild"], 30, "构建号"],
  ["artifactId", ["artifactId", "artifact"], 28, "产物 ID"],
  ["applicationId", ["applicationId", "packageName"], 26, "applicationId"],
  ["versionName", ["versionName"], 24, "版本名"],
  ["versionCode", ["versionCode"], 22, "版本号"],
  ["gradleTask", ["gradleTask", "task"], 20, "Gradle 任务"],
];

function stringValue(value, max = 20000) {
  const text = String(value == null ? "" : value).trim();
  return text.length > max ? text.slice(0, max) : text;
}

function stringList(value, maxItems = 100) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\n,，;；]+/);
  return [...new Set(values.map((item) => {
    if (item && typeof item === "object") return stringValue(item.name || item.title || item.content || item.fileName, 500);
    return stringValue(item, 500);
  }).filter(Boolean))].slice(0, maxItems);
}

function compact(value) {
  return stringValue(value, 100000).toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, "");
}

function normalizedText(value) {
  return stringValue(value, 100000).toLowerCase();
}

function firstValue(source, keys) {
  for (const key of keys) {
    const value = stringValue(source?.[key], 1000);
    if (value) return value;
  }
  return "";
}

function hasSignal(text, value) {
  const needle = normalizedText(value);
  if (!needle || needle.length < 2) return false;
  return text.includes(needle) || compact(text).includes(compact(needle));
}

function tokenSet(value) {
  const tokens = normalizedText(value).match(/[a-z0-9][a-z0-9._/-]*|[\u3400-\u9fff]{2,}/g) || [];
  return new Set(tokens.filter((token) => token.length > 1));
}

function similarity(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common++;
  return common / Math.max(left.size, right.size);
}

function targetVariant(target = {}) {
  const variant = target.variant && typeof target.variant === "object" ? target.variant : {};
  return {
    vehicle: stringValue(variant.vehicle || target.vehicle || target.flavor, 120),
    environment: stringValue(variant.environment || target.environment, 80),
    buildType: stringValue(variant.buildType || target.buildType, 80),
  };
}

export function normalizeStoryTicket(input = {}) {
  const tags = stringList(input.tags, 100);
  const attachments = (Array.isArray(input.attachments) ? input.attachments : stringList(input.attachments, 100))
    .map((item) => {
      if (item && typeof item === "object") {
        return {
          id: stringValue(item.id || item._id, 120),
          name: stringValue(item.name || item.fileName || item.title, 500),
          size: Number(item.size || item.fileSize || 0) || 0,
          source: stringValue(item.source || item._source, 80),
        };
      }
      return { id: "", name: stringValue(item, 500), size: 0, source: "manual" };
    })
    .filter((item) => item.name)
    .slice(0, 100);
  return {
    ticketId: stringValue(input.ticketId || input.carbId || input.tbTaskId, 160),
    tbTaskId: stringValue(input.tbTaskId, 160),
    ticketUrl: stringValue(input.ticketUrl || input.url, 1200),
    title: stringValue(input.title, 1000),
    description: stringValue(input.description || input.note || input.text, 30000),
    comments: stringValue(Array.isArray(input.comments) ? input.comments.join("\n") : input.comments, 30000),
    logs: stringValue(input.logs, 60000),
    tags,
    projectName: stringValue(input.projectName, 500),
    iterationName: stringValue(input.iterationName || input.sprintName, 500),
    environment: stringValue(input.environment, 80),
    buildType: stringValue(input.buildType, 80),
    attachments,
    sourceCoverage: input.sourceCoverage && typeof input.sourceCoverage === "object" ? input.sourceCoverage : {},
    snapshotAt: stringValue(input.snapshotAt, 80) || new Date().toISOString(),
  };
}

export function normalizeBuildLineage(input = {}, existing = {}) {
  return {
    ...existing,
    id: stringValue(input.id || existing.id, 160),
    buildNumber: stringValue(input.buildNumber, 160),
    artifactId: stringValue(input.artifactId, 500),
    versionName: stringValue(input.versionName, 160),
    versionCode: stringValue(input.versionCode, 160),
    commitSha: stringValue(input.commitSha || input.commit, 160),
    repositoryId: stringValue(input.repositoryId || input.repoId || input.projectId, 160),
    branch: stringValue(input.branch || input.sourceBranch, 500),
    vehicle: stringValue(input.vehicle || input.flavor, 160),
    environment: stringValue(input.environment, 80),
    buildType: stringValue(input.buildType, 80),
    gradleTask: stringValue(input.gradleTask || input.task, 500),
    applicationId: stringValue(input.applicationId || input.packageName, 500),
    source: stringValue(input.source || input.jenkinsJob, 1000),
    createdAt: existing.createdAt || input.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

export function normalizeGoldCase(input = {}, existing = {}) {
  const ticket = normalizeStoryTicket(input.ticket || input);
  const actual = input.actual && typeof input.actual === "object" ? input.actual : {};
  const rawTargets = actual.changeTargets || input.changeTargets || [];
  const changeTargets = (Array.isArray(rawTargets) ? rawTargets : []).map((target) => ({
    repositoryId: stringValue(target.repositoryId || target.repoId || target.projectId, 160),
    repositoryName: stringValue(target.repositoryName || target.repoName, 500),
    baseBranch: stringValue(target.baseBranch || target.branch, 500),
    reproductionBranch: stringValue(target.reproductionBranch, 500),
    variant: targetVariant(target),
  })).filter((target) => target.repositoryId);
  const createdAt = existing.createdAt || input.createdAt || Date.now();
  const availableAt = existing.availableAt || input.availableAt || input.reviewedAt || createdAt;
  const versions = {
    router: ROUTER_VERSION,
    registry: REGISTRY_VERSION,
    prompt: "no-llm-rules-v1",
    ...(existing.versions && typeof existing.versions === "object" ? existing.versions : {}),
    ...(input.versions && typeof input.versions === "object" ? input.versions : {}),
  };
  return {
    ...existing,
    id: stringValue(input.id || existing.id, 160),
    ticket,
    actual: {
      symptomProject: actual.symptomProject || input.symptomProject || null,
      changeTargets,
    },
    reviewer: stringValue(input.reviewer || existing.reviewer, 200),
    reason: stringValue(input.reason || input.feedbackReason, 4000),
    sourceDryRunId: stringValue(input.sourceDryRunId, 160),
    snapshotAt: stringValue(input.snapshotAt || ticket.snapshotAt, 80),
    availableAt,
    versions,
    createdAt,
    updatedAt: Date.now(),
  };
}

function ticketSearchText(ticket) {
  return [
    ticket.ticketId,
    ticket.title,
    ticket.description,
    ticket.comments,
    ticket.logs,
    ticket.projectName,
    ticket.iterationName,
    ticket.environment,
    ticket.buildType,
    ...ticket.tags,
    ...ticket.attachments.map((item) => item.name),
  ].filter(Boolean).join("\n");
}

function groupText(ticket, group) {
  if (group === "title") return ticket.title;
  if (group === "project") return ticket.projectName;
  if (group === "iteration") return ticket.iterationName;
  if (group === "tag") return ticket.tags.join("\n");
  return ticketSearchText(ticket);
}

function mappingEntries(mapping = {}) {
  if (Array.isArray(mapping.apps)) {
    return mapping.apps.flatMap((app) => (Array.isArray(app?.repos) ? app.repos : []).map((repo) => ({
      appName: stringValue(app?.appName, 500),
      repositoryId: stringValue(repo?.repoId || repo?.projectId, 160),
      branch: stringValue(repo?.branch, 500),
      flavor: stringValue(repo?.flavor, 160),
    })));
  }
  return (Array.isArray(mapping.entries) ? mapping.entries : []).map((entry) => ({
    appName: "",
    repositoryId: stringValue(entry?.projectId || entry?.repoId, 160),
    branch: stringValue(entry?.branch, 500),
    flavor: stringValue(entry?.flavor, 160),
  }));
}

export function storyTrainingRegistryTargets(projectDefs = [], vehicleMap = {}) {
  const defs = new Set((Array.isArray(projectDefs) ? projectDefs : []).map((def) => stringValue(def?.id, 160)).filter(Boolean));
  const targets = new Map();
  for (const [vehicle, mapping] of Object.entries(vehicleMap && typeof vehicleMap === "object" ? vehicleMap : {})) {
    for (const entry of mappingEntries(mapping)) {
      const repositoryId = stringValue(entry.repositoryId, 160);
      const baseBranch = stringValue(entry.branch, 500);
      const registeredVehicle = stringValue(entry.flavor || vehicle, 160);
      if (!defs.has(repositoryId) || !baseBranch || !registeredVehicle) continue;
      const key = `${repositoryId}|${baseBranch}|${compact(registeredVehicle)}`;
      targets.set(key, { repositoryId, baseBranch, vehicle: registeredVehicle });
    }
  }
  return [...targets.values()];
}

export function validateStoryTrainingTargets(targets = [], input = {}) {
  const rows = Array.isArray(targets) ? targets : [];
  if (!rows.length) return { ok: false, error: "至少需要一个变更目标" };
  const registered = storyTrainingRegistryTargets(input.projectDefs, input.vehicleMap);
  const registeredRepositories = new Set((Array.isArray(input.projectDefs) ? input.projectDefs : []).map((def) => stringValue(def?.id, 160)).filter(Boolean));
  const lineageBranches = new Set((Array.isArray(input.buildLineage) ? input.buildLineage : []).map((row) => {
    const normalized = normalizeBuildLineage(row, row);
    return normalized.repositoryId && normalized.branch ? `${normalized.repositoryId}|${normalized.branch}` : "";
  }).filter(Boolean));

  for (const rawTarget of rows) {
    const repositoryId = stringValue(rawTarget?.repositoryId || rawTarget?.repoId || rawTarget?.projectId, 160);
    const baseBranch = stringValue(rawTarget?.baseBranch || rawTarget?.branch, 500);
    const reproductionBranch = stringValue(rawTarget?.reproductionBranch, 500);
    const variant = targetVariant(rawTarget);
    if (!registeredRepositories.has(repositoryId)) return { ok: false, error: "变更目标只能使用工程注册表中的仓库" };
    if (!baseBranch || !variant.vehicle || !variant.environment || !variant.buildType) {
      return { ok: false, error: "每个变更目标都需要目标分支、车型、环境和 buildType" };
    }
    const registeredTarget = registered.some((target) => (
      target.repositoryId === repositoryId
      && target.baseBranch === baseBranch
      && compact(target.vehicle) === compact(variant.vehicle)
    ));
    if (!registeredTarget) return { ok: false, error: `${repositoryId} 的目标分支与车型组合未在工程注册表中登记` };
    if (!STORY_TRAINING_ENVIRONMENTS.includes(variant.environment.toLowerCase())) {
      return { ok: false, error: `环境仅允许 ${STORY_TRAINING_ENVIRONMENTS.join("/")}` };
    }
    if (!STORY_TRAINING_BUILD_TYPES.includes(variant.buildType.toLowerCase())) {
      return { ok: false, error: `buildType 仅允许 ${STORY_TRAINING_BUILD_TYPES.join("/")}` };
    }
    if (reproductionBranch && !lineageBranches.has(`${repositoryId}|${reproductionBranch}`)) {
      return { ok: false, error: `${repositoryId} 的复现分支必须来自同仓库构建血缘` };
    }
  }
  return { ok: true };
}

export function routeStoryPointTicket(input = {}) {
  const ticket = normalizeStoryTicket(input.ticket || input);
  const projectDefs = (Array.isArray(input.projectDefs) ? input.projectDefs : []).map((def) => ({
    id: stringValue(def?.id, 160),
    name: stringValue(def?.name || def?.id, 500),
  })).filter((def) => def.id);
  const defsById = new Map(projectDefs.map((def) => [def.id, def]));
  const vehicleMap = input.vehicleMap && typeof input.vehicleMap === "object" ? input.vehicleMap : {};
  const keywordMappings = input.keywordMappings && typeof input.keywordMappings === "object" ? input.keywordMappings : {};
  const buildLineage = Array.isArray(input.buildLineage) ? input.buildLineage : [];
  const goldCases = Array.isArray(input.goldCases) ? input.goldCases : [];
  const text = ticketSearchText(ticket);
  const textLower = normalizedText(text);
  const textCompact = compact(text);
  const evidence = [];
  const evidenceKeys = new Set();
  const candidates = new Map();

  const addEvidence = (tier, field, value, source, weight, detail = "") => {
    const key = [tier, field, value, source, detail].join("|");
    if (evidenceKeys.has(key)) return evidence.find((item) => item._key === key)?.id || "";
    const id = `E${evidence.length + 1}`;
    evidenceKeys.add(key);
    evidence.push({ id, tier, field, value: stringValue(value, 1000), source, weight, detail: stringValue(detail, 2000), _key: key });
    return id;
  };

  const candidateKey = (repositoryId, vehicle) => `${repositoryId}|${compact(vehicle)}`;
  const addCandidate = (target, score, evidenceId, sourceKind) => {
    const repositoryId = stringValue(target.repositoryId || target.repoId || target.projectId, 160);
    const def = defsById.get(repositoryId);
    if (!def) return null;
    const variant = targetVariant(target);
    variant.environment = allowedDimension(variant.environment, STORY_TRAINING_ENVIRONMENTS);
    variant.buildType = allowedDimension(variant.buildType, STORY_TRAINING_BUILD_TYPES);
    let key = candidateKey(repositoryId, variant.vehicle);
    if (!variant.vehicle) {
      const sameRepo = [...candidates.entries()].find(([, item]) => item.repositoryId === repositoryId && item.variant.vehicle);
      if (sameRepo) key = sameRepo[0];
    }
    const current = candidates.get(key) || {
      repositoryId,
      repositoryName: def.name,
      baseBranch: "",
      reproductionBranch: "",
      variant: { vehicle: "", environment: "", buildType: "" },
      score: 0,
      hardScore: 0,
      evidenceIds: [],
      sourceKinds: [],
    };
    if (target.baseBranch || target.branch) current.baseBranch = stringValue(target.baseBranch || target.branch, 500);
    if (target.reproductionBranch) current.reproductionBranch = stringValue(target.reproductionBranch, 500);
    current.variant = {
      vehicle: variant.vehicle || current.variant.vehicle,
      environment: variant.environment || current.variant.environment,
      buildType: variant.buildType || current.variant.buildType,
    };
    current.score += Number(score) || 0;
    if (sourceKind === "hard") current.hardScore += Number(score) || 0;
    if (evidenceId && !current.evidenceIds.includes(evidenceId)) current.evidenceIds.push(evidenceId);
    if (sourceKind && !current.sourceKinds.includes(sourceKind)) current.sourceKinds.push(sourceKind);
    candidates.set(key, current);
    return current;
  };

  const detectedVehicles = new Map();
  for (const key of Object.keys(vehicleMap)) {
    if (hasSignal(textLower, key) || (compact(key).length >= 4 && textCompact.includes(compact(key)))) {
      const evidenceId = addEvidence("medium", "vehicle", key, "ticket", 30, "工单内容命中车型/variant 注册项");
      detectedVehicles.set(key, { weight: 30, evidenceId, source: "ticket" });
    }
  }

  const detectedApps = new Map();
  for (const [group, mappings] of Object.entries(keywordMappings)) {
    if (!mappings || typeof mappings !== "object") continue;
    const sourceText = groupText(ticket, group);
    for (const [keyword, mapping] of Object.entries(mappings)) {
      if (!mapping?.value || !hasSignal(sourceText, keyword)) continue;
      const category = stringValue(mapping.category, 80);
      const value = stringValue(mapping.value, 500);
      const evidenceId = addEvidence("medium", `${group}Keyword`, keyword, "keyword_mapping", 24, `${category}:${value}`);
      if (category === "vehicle") {
        const vehicleKey = Object.keys(vehicleMap).find((key) => compact(key) === compact(value)) || value;
        if (vehicleMap[vehicleKey]) detectedVehicles.set(vehicleKey, { weight: 24, evidenceId, source: "keyword_mapping" });
      } else if (category === "app") {
        detectedApps.set(compact(value), { value, evidenceId });
      }
    }
  }

  for (const [vehicle, signal] of detectedVehicles) {
    const mapping = vehicleMap[vehicle] || {};
    for (const entry of mappingEntries(mapping)) {
      if (!defsById.has(entry.repositoryId)) continue;
      const appSignal = entry.appName && detectedApps.get(compact(entry.appName));
      const boost = appSignal ? 10 : 0;
      const candidate = addCandidate({
        repositoryId: entry.repositoryId,
        baseBranch: entry.branch,
        vehicle: entry.flavor || vehicle,
        environment: ticket.environment,
        buildType: ticket.buildType,
      }, signal.weight + 12 + boost, signal.evidenceId, "medium");
      if (candidate && appSignal) {
        candidate.score += 10;
        if (!candidate.evidenceIds.includes(appSignal.evidenceId)) candidate.evidenceIds.push(appSignal.evidenceId);
      }
    }
  }

  for (const rawRow of buildLineage) {
    const row = normalizeBuildLineage(rawRow, rawRow);
    if (!defsById.has(row.repositoryId)) continue;
    let score = 0;
    const matchedEvidence = [];
    for (const [field, aliases, weight, label] of HARD_FIELDS) {
      const value = firstValue(row, aliases);
      if (!value || !hasSignal(textLower, value)) continue;
      const evidenceId = addEvidence("hard", field, value, "build_lineage", weight, `${label}命中构建血缘 ${row.id || row.source || "记录"}`);
      score += weight;
      matchedEvidence.push(evidenceId);
    }
    if (!score) continue;
    const detectedVehicle = row.vehicle || (detectedVehicles.size === 1 ? [...detectedVehicles.keys()][0] : "");
    const candidate = addCandidate({
      repositoryId: row.repositoryId,
      reproductionBranch: row.branch,
      vehicle: detectedVehicle,
      environment: row.environment || ticket.environment,
      buildType: row.buildType || ticket.buildType,
    }, Math.min(score, 92), matchedEvidence[0], "hard");
    if (candidate) {
      for (const evidenceId of matchedEvidence.slice(1)) if (!candidate.evidenceIds.includes(evidenceId)) candidate.evidenceIds.push(evidenceId);
      const mapped = [...candidates.values()].find((item) => item !== candidate && item.repositoryId === row.repositoryId && item.variant.vehicle && compact(item.variant.vehicle) === compact(detectedVehicle));
      if (mapped) {
        mapped.score += candidate.score;
        mapped.hardScore += candidate.hardScore;
        mapped.reproductionBranch = candidate.reproductionBranch || mapped.reproductionBranch;
        mapped.variant.environment = candidate.variant.environment || mapped.variant.environment;
        mapped.variant.buildType = candidate.variant.buildType || mapped.variant.buildType;
        mapped.evidenceIds = [...new Set([...mapped.evidenceIds, ...candidate.evidenceIds])];
        candidates.delete(candidateKey(candidate.repositoryId, candidate.variant.vehicle));
        candidates.set(candidateKey(mapped.repositoryId, mapped.variant.vehicle), mapped);
      }
    }
  }

  for (const def of projectDefs) {
    if (!hasSignal(textLower, def.id) && !hasSignal(textLower, def.name)) continue;
    const evidenceId = addEvidence("medium", "repository", def.name, "engineering_registry", 18, "工单内容直接命中工程注册表");
    addCandidate({ repositoryId: def.id, environment: ticket.environment, buildType: ticket.buildType }, 18, evidenceId, "medium");
  }

  const knownBranches = new Map();
  for (const [vehicle, mapping] of Object.entries(vehicleMap)) {
    for (const entry of mappingEntries(mapping)) {
      if (entry.branch) knownBranches.set(`${entry.repositoryId}|${entry.branch}`, { repositoryId: entry.repositoryId, branch: entry.branch, vehicle: entry.flavor || vehicle });
    }
  }
  for (const branch of knownBranches.values()) {
    if (!defsById.has(branch.repositoryId) || !hasSignal(textLower, branch.branch)) continue;
    const evidenceId = addEvidence("hard", "branch", branch.branch, "registered_branch", 24, "工单内容命中候选分支");
    addCandidate({ repositoryId: branch.repositoryId, baseBranch: branch.branch, vehicle: branch.vehicle }, 24, evidenceId, "hard");
  }
  for (const rawRow of buildLineage) {
    const row = normalizeBuildLineage(rawRow, rawRow);
    if (!defsById.has(row.repositoryId) || !row.branch || !hasSignal(textLower, row.branch)) continue;
    const evidenceId = addEvidence("hard", "reproductionBranch", row.branch, "build_lineage", 24, "工单内容命中构建血缘源分支");
    addCandidate({ repositoryId: row.repositoryId, reproductionBranch: row.branch, vehicle: row.vehicle }, 24, evidenceId, "hard");
  }

  const ticketSimilarityText = [ticket.title, ticket.description, ticket.tags.join(" ")].join(" ");
  const ticketSnapshotTime = timestampValue(ticket.snapshotAt);
  for (const rawCase of goldCases) {
    const gold = normalizeGoldCase(rawCase, rawCase);
    const availabilityTimes = [rawCase?.availableAt, rawCase?.reviewedAt, rawCase?.createdAt]
      .map(timestampValue)
      .filter(Number.isFinite);
    const goldAvailableTime = availabilityTimes.length ? Math.max(...availabilityTimes) : timestampValue(rawCase?.snapshotAt);
    if (Number.isFinite(ticketSnapshotTime) && Number.isFinite(goldAvailableTime) && goldAvailableTime > ticketSnapshotTime) continue;
    const goldText = [gold.ticket.title, gold.ticket.description, gold.ticket.tags.join(" ")].join(" ");
    const sim = similarity(ticketSimilarityText, goldText);
    const exactTag = ticket.tags.some((tag) => gold.ticket.tags.some((item) => compact(item) === compact(tag)));
    if (sim < 0.16 && !exactTag) continue;
    const validTargets = gold.actual.changeTargets.filter((target) => validateStoryTrainingTargets([target], {
      projectDefs,
      vehicleMap,
      buildLineage,
    }).ok);
    if (!validTargets.length) continue;
    const weight = Math.round(12 + Math.min(1, sim + (exactTag ? 0.2 : 0)) * 18);
    const evidenceId = addEvidence("soft", "historicalCase", gold.ticket.ticketId || gold.id, "gold_dataset", weight, `历史相似度 ${(sim * 100).toFixed(0)}%`);
    for (const target of validTargets) addCandidate(target, weight, evidenceId, "soft");
  }

  const rows = [...candidates.values()];
  for (const loose of rows.filter((item) => !item.variant.vehicle)) {
    const specific = rows.find((item) => item !== loose && item.repositoryId === loose.repositoryId && item.variant.vehicle);
    if (!specific) continue;
    specific.score += loose.score;
    specific.hardScore += loose.hardScore;
    specific.evidenceIds = [...new Set([...specific.evidenceIds, ...loose.evidenceIds])];
    specific.sourceKinds = [...new Set([...specific.sourceKinds, ...loose.sourceKinds])];
    candidates.delete(candidateKey(loose.repositoryId, ""));
  }

  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score || b.hardScore - a.hardScore || a.repositoryId.localeCompare(b.repositoryId));
  const topScore = ranked[0]?.score || 0;
  const selected = ranked.filter((item, index) => index === 0 || (item.score >= 28 && item.score >= topScore * 0.62)).slice(0, 5);
  const changeTargets = selected.map((item) => {
    const confidence = Math.min(0.98, Math.max(0.2, 0.28 + item.score / 125 + item.hardScore / 300));
    return {
      repositoryId: item.repositoryId,
      repositoryName: item.repositoryName,
      baseBranch: item.baseBranch,
      reproductionBranch: item.reproductionBranch,
      variant: item.variant,
      confidence: Number(confidence.toFixed(2)),
      evidenceIds: item.evidenceIds,
    };
  });
  const confidenceScore = changeTargets[0]?.confidence || 0;
  const missingInformation = [];
  if (!ticket.title && !ticket.description && !ticket.logs && !ticket.comments) missingInformation.push("缺少可分析的标题、描述、评论或日志");
  if (!changeTargets.length) missingInformation.push("未命中工程注册表中的候选仓库");
  if (changeTargets.length && changeTargets.some((target) => !target.baseBranch)) missingInformation.push("缺少变更目标分支");
  if (changeTargets.length && changeTargets.every((target) => !target.variant.vehicle)) missingInformation.push("缺少车型/variant");
  if (changeTargets.length && changeTargets.every((target) => !target.variant.environment)) missingInformation.push("缺少环境维度");
  if (changeTargets.length && changeTargets.every((target) => !target.variant.buildType)) missingInformation.push("缺少 buildType");
  const status = changeTargets.length ? "NEED_HUMAN_CONFIRMATION" : "NEED_MORE_INFO";

  return {
    ticketId: ticket.ticketId || ticket.tbTaskId,
    status,
    symptomProject: changeTargets[0] ? {
      repositoryId: changeTargets[0].repositoryId,
      repositoryName: changeTargets[0].repositoryName,
      confidence: changeTargets[0].confidence,
    } : null,
    changeTargets,
    missingInformation,
    recommendedNextAction: changeTargets.length ? "人工确认路由后生成开发计划" : "补充构建号、提交 SHA、车型或工程线索后重试",
    confidenceScore,
    evidence: evidence.map(({ _key, ...item }) => item).sort((a, b) => b.weight - a.weight),
    policy: {
      automationLevel: "L0_SHADOW",
      candidateConstrained: true,
      canExecute: false,
      routerVersion: ROUTER_VERSION,
      registryVersion: REGISTRY_VERSION,
    },
  };
}

export const STORY_TRAINING_VERSIONS = {
  router: ROUTER_VERSION,
  registry: REGISTRY_VERSION,
  prompt: "no-llm-rules-v1",
};
