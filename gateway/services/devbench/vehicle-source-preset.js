import { readRemoteBranchFiles } from "./git-remote.js";
import { getAndroidFlavorInfoFromFiles } from "./store.js";

export const APP_MARKET_VEHICLE_PRESET_POLICY = Object.freeze({
  repositoryId: "appMarket",
  branchPatterns: Object.freeze(["release/*", "v202605-ui", "v202601"]),
  filePaths: Object.freeze([
    "flavorConfig.json",
    "project_flavor.gradle",
    "app/project_flavor.gradle",
  ]),
});

function normalizedSubscriptions(value = []) {
  return (Array.isArray(value) ? value : [])
    .map((application) => ({
      appName: String(application?.name || application?.appName || "").trim(),
      repositories: (Array.isArray(application?.repositories) ? application.repositories : [])
        .map((repository) => String(repository?.repositoryId || repository?.repoId || "").trim())
        .filter(Boolean),
    }))
    .filter((application) => application.appName && application.repositories.length);
}

function mappingTupleKey(repository = {}) {
  return [repository.repoId, repository.branch, repository.flavor]
    .map((value) => String(value || "").trim())
    .join("\u0000");
}

function addSuggestion(vehicleMap, vehicle, appName, repository) {
  const key = String(vehicle || "").trim();
  if (!key) return false;
  const mapping = vehicleMap[key] || { apps: [] };
  let application = mapping.apps.find((item) => item.appName === appName);
  if (!application) {
    application = { appName, repos: [] };
    mapping.apps.push(application);
  }
  const tuple = mappingTupleKey(repository);
  if (application.repos.some((item) => mappingTupleKey(item) === tuple)) return false;
  application.repos.push(repository);
  vehicleMap[key] = mapping;
  return true;
}

function sortedVehicleMap(vehicleMap) {
  return Object.fromEntries(Object.entries(vehicleMap)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([vehicle, mapping]) => [vehicle, {
      apps: mapping.apps
        .map((application) => ({
          appName: application.appName,
          repos: [...application.repos].sort((left, right) => (
            `${left.repoId}\u0000${left.branch}\u0000${left.flavor}`
              .localeCompare(`${right.repoId}\u0000${right.branch}\u0000${right.flavor}`)
          )),
        }))
        .sort((left, right) => left.appName.localeCompare(right.appName)),
    }]));
}

/**
 * 根据“应用 → 仓库订阅”生成初始车型源码候选。当前只为应用市场仓库启用自动规则；
 * 其它仓库继续由用户在车型配置中自定义添加，避免对未知仓库结构做猜测。
 */
export async function buildVehicleSourcePresetSuggestions({
  subscriptions = [],
  projectDefs = [],
  scanRemote = readRemoteBranchFiles,
} = {}) {
  const applications = normalizedSubscriptions(subscriptions);
  const definitions = new Map((Array.isArray(projectDefs) ? projectDefs : [])
    .map((definition) => [String(definition?.id || "").trim(), definition])
    .filter(([id]) => id));
  if (!applications.length) {
    return {
      ok: false,
      code: "VEHICLE_PRESET_SUBSCRIPTIONS_REQUIRED",
      error: "尚未配置应用与仓库订阅，请先在“应用工程配置”中保存至少一个应用和仓库",
      vehicleMap: {},
      report: null,
    };
  }

  const repositoryApps = new Map();
  for (const application of applications) {
    for (const repositoryId of application.repositories) {
      if (!repositoryApps.has(repositoryId)) repositoryApps.set(repositoryId, new Set());
      repositoryApps.get(repositoryId).add(application.appName);
    }
  }

  const eligibleRepositoryIds = [...repositoryApps.keys()]
    .filter((repositoryId) => repositoryId === APP_MARKET_VEHICLE_PRESET_POLICY.repositoryId);
  const skippedRepositories = [...repositoryApps.keys()]
    .filter((repositoryId) => !eligibleRepositoryIds.includes(repositoryId))
    .map((repositoryId) => ({
      repositoryId,
      repositoryName: definitions.get(repositoryId)?.name || repositoryId,
      reason: "未配置自动扫描规则，保留用户自定义映射",
    }));
  const report = {
    policy: {
      repositoryId: APP_MARKET_VEHICLE_PRESET_POLICY.repositoryId,
      branchPatterns: [...APP_MARKET_VEHICLE_PRESET_POLICY.branchPatterns],
      filePaths: [...APP_MARKET_VEHICLE_PRESET_POLICY.filePaths],
    },
    subscribedApplications: applications.length,
    subscribedRepositories: repositoryApps.size,
    eligibleRepositories: eligibleRepositoryIds.length,
    matchedBranches: 0,
    scannedBranches: 0,
    configBranches: 0,
    generatedVehicles: 0,
    generatedMappings: 0,
    skippedRepositories,
    sources: [],
    warnings: [],
    failures: [],
  };
  if (!eligibleRepositoryIds.length) {
    return { ok: true, partial: false, vehicleMap: {}, report };
  }

  const vehicleMap = {};
  let successfulRepositories = 0;
  for (const repositoryId of eligibleRepositoryIds) {
    const definition = definitions.get(repositoryId);
    if (!definition || (!definition.https && !definition.ssh)) {
      report.failures.push({ repositoryId, error: "仓库定义不存在或未配置远程地址" });
      continue;
    }
    const scanned = await scanRemote({ https: definition.https, ssh: definition.ssh }, {
      branchPatterns: APP_MARKET_VEHICLE_PRESET_POLICY.branchPatterns,
      filePaths: APP_MARKET_VEHICLE_PRESET_POLICY.filePaths,
    });
    if (!scanned?.ok) {
      report.failures.push({ repositoryId, error: scanned?.error || "远程仓库扫描失败" });
      continue;
    }
    successfulRepositories += 1;
    report.matchedBranches += scanned.matchedBranches?.length || 0;
    report.scannedBranches += scanned.branches?.length || 0;
    const repositorySource = {
      repositoryId,
      repositoryName: definition.name || repositoryId,
      transport: scanned.transport || null,
      fallback: scanned.fallback === true,
      matchedBranches: scanned.matchedBranches?.length || 0,
      configBranches: [],
    };
    for (const branchRow of scanned.branches || []) {
      for (const fileError of branchRow.fileErrors || []) {
        report.warnings.push(`${repositoryId}@${branchRow.branch}/${fileError.file}：${fileError.error}`);
      }
      const flavorInfo = getAndroidFlavorInfoFromFiles(branchRow.files || {});
      for (const error of flavorInfo.errors || []) {
        report.warnings.push(`${repositoryId}@${branchRow.branch}：${error}`);
      }
      if (!flavorInfo.flavors.length) continue;
      report.configBranches += 1;
      repositorySource.configBranches.push({
        branch: branchRow.branch,
        source: flavorInfo.source,
        flavors: [...flavorInfo.flavors],
      });
      for (const appName of repositoryApps.get(repositoryId) || []) {
        for (const flavor of flavorInfo.flavors) {
          if (addSuggestion(vehicleMap, flavor, appName, {
            repoId: repositoryId,
            branch: branchRow.branch,
            flavor,
          })) report.generatedMappings += 1;
        }
      }
    }
    report.sources.push(repositorySource);
  }

  const sorted = sortedVehicleMap(vehicleMap);
  report.generatedVehicles = Object.keys(sorted).length;
  if (!successfulRepositories && report.failures.length) {
    return {
      ok: false,
      code: "VEHICLE_PRESET_SCAN_FAILED",
      error: report.failures.map((failure) => `${failure.repositoryId}：${failure.error}`).join("；"),
      vehicleMap: {},
      report,
    };
  }
  return {
    ok: true,
    partial: report.failures.length > 0,
    vehicleMap: sorted,
    report,
  };
}
