import { randomUUID } from "node:crypto";

function text(value, limit = 1000) {
  return String(value ?? "").trim().slice(0, limit);
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function gateFingerprint(value) {
  return JSON.stringify(stable(value || null));
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export function wilsonLowerBound(successes, total, z = 1.96) {
  const n = Math.max(0, finite(total));
  if (!n) return null;
  const p = Math.min(1, Math.max(0, finite(successes) / n));
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (center - margin) / denominator);
}

export function createConfigInferenceArtifact(input = {}, {
  operator = "",
  now = Date.now(),
  idFactory = () => `MA_${randomUUID()}`,
} = {}) {
  const datasetHash = text(input.datasetHash, 128);
  const projectId = text(input.projectId, 300);
  const rulesVersion = text(input.rulesVersion, 160);
  const featureSchemaVersion = text(input.featureSchemaVersion, 160);
  if (!projectId) throw new Error("model artifact 必须冻结 projectId");
  if (!datasetHash) throw new Error("model artifact 必须引用 datasetHash");
  if (!rulesVersion) throw new Error("model artifact 必须记录 rulesVersion");
  if (!featureSchemaVersion) throw new Error("model artifact 必须记录 featureSchemaVersion");
  return deepFreeze({
    id: text(input.id || idFactory(), 160),
    schemaVersion: "config-inference-artifact-v1",
    projectId,
    datasetHash,
    datasetVersion: text(input.datasetVersion, 160),
    registryRevision: text(input.registryRevision, 160),
    keywordRevision: text(input.keywordRevision, 160),
    servingSampleRevision: text(input.servingSampleRevision, 160),
    knowledgeValueSetRevision: text(input.knowledgeValueSetRevision, 160),
    rulesVersion,
    featureSchemaVersion,
    ranker: cloneValue(input.ranker || { method: "heuristic", version: rulesVersion }),
    calibrator: cloneValue(input.calibrator || { status: "unavailable" }),
    createdAt: nowIso(now),
    createdBy: text(operator || input.createdBy, 200),
  });
}

export function evaluateConfigInferenceReleaseGate(metrics = {}, validation = {}, {
  minShadowCases = 200,
  top3Threshold = 0.98,
  eceThreshold = 0.05,
  selectiveRiskThreshold = 0.005,
  graphAccuracyThreshold = 0.99,
  graphLowerBoundThreshold = 0.97,
  evaluationSplit = metrics.evaluationSplit || metrics.split,
  calibratorStatus = metrics.calibratorStatus,
  requiredSources = validation.requiredSources,
} = {}) {
  const eligible = Math.max(0, finite(metrics.eligible));
  const exactMatch = finite(metrics.exactMatch, -1);
  const graphSuccesses = Math.round(Math.max(0, exactMatch) * eligible);
  const lowerBound = wilsonLowerBound(graphSuccesses, eligible);
  const registryViolations = Math.max(0, finite(metrics.registryViolations));
  const requiredSourceAutoRuns = Math.max(0, finite(metrics.requiredSourceAutoRuns));
  const leakageErrors = (validation.errors || []).filter((row) => (
    ["FUTURE_EVIDENCE_LEAKAGE", "EVIDENCE_TIME_MISSING", "GROUP_SPLIT_LEAKAGE"].includes(row.code)
  )).length;
  const split = text(evaluationSplit, 40).toLowerCase();
  const splitCounts = validation?.splitCounts || {};
  const sources = (Array.isArray(requiredSources) ? requiredSources : [])
    .map((value) => text(value, 80))
    .filter(Boolean);
  const shadowReasons = [
    ...(!validation.ok ? ["dataset_validation_failed"] : []),
    ...(leakageErrors ? ["dataset_leakage"] : []),
    ...(registryViolations ? ["registry_violation"] : []),
    ...(!["test", "shadow"].includes(split) ? ["evaluation_split_invalid"] : []),
    ...(!Number(splitCounts.dev) ? ["dev_split_empty"] : []),
    ...(!Number(splitCounts.test) ? ["test_split_empty"] : []),
    ...(!sources.includes("detail") ? ["required_source_policy_missing"] : []),
  ];
  const reasons = [
    ...shadowReasons,
    ...(requiredSourceAutoRuns ? ["required_source_auto_run"] : []),
    ...(text(calibratorStatus).toLowerCase() !== "fitted" ? ["calibrator_not_fitted"] : []),
    ...(finite(metrics.repositoryTop3Recall, -1) < top3Threshold ? ["top3_below_threshold"] : []),
    ...(finite(metrics.expectedCalibrationError, Number.POSITIVE_INFINITY) > eceThreshold ? ["ece_above_threshold"] : []),
    ...(finite(metrics.selectiveRisk, Number.POSITIVE_INFINITY) > selectiveRiskThreshold ? ["selective_risk_above_threshold"] : []),
    ...(eligible < minShadowCases ? ["shadow_sample_insufficient"] : []),
  ];
  const canaryReady = reasons.length === 0;
  const autoExecutionReasons = [
    ...reasons,
    ...(exactMatch < graphAccuracyThreshold ? ["graph_accuracy_below_threshold"] : []),
    ...(lowerBound == null || lowerBound < graphLowerBoundThreshold ? ["graph_lower_bound_below_threshold"] : []),
  ];
  return deepFreeze({
    shadowReady: shadowReasons.length === 0,
    canaryReady,
    autoExecutionReady: autoExecutionReasons.length === 0,
    reasons: [...new Set(reasons)],
    autoExecutionReasons: [...new Set(autoExecutionReasons)],
    graphAccuracyLowerBound95: lowerBound == null ? null : Number(lowerBound.toFixed(6)),
    thresholds: {
      minShadowCases,
      top3: top3Threshold,
      ece: eceThreshold,
      selectiveRisk: selectiveRiskThreshold,
      graphAccuracy: graphAccuracyThreshold,
      graphLowerBound95: graphLowerBoundThreshold,
      evaluationSplits: ["test", "shadow"],
      requiredSources: ["detail"],
    },
  });
}

export function createConfigInferenceRelease(input = {}, {
  operator = "",
  now = Date.now(),
  idFactory = () => `REL_${randomUUID()}`,
} = {}) {
  const artifactId = text(input.artifactId, 160);
  if (!artifactId) throw new Error("serving release 必须引用 artifactId");
  return deepFreeze({
    id: text(input.id || idFactory(), 160),
    schemaVersion: "config-inference-release-v1",
    artifactId,
    projectId: text(input.projectId, 200),
    status: "draft",
    trafficPercent: 0,
    autoExecutionEnabled: false,
    gate: cloneValue(input.gate || null),
    createdAt: nowIso(now),
    createdBy: text(operator || input.createdBy, 200),
    history: [],
  });
}

const RELEASE_TRANSITIONS = {
  draft: new Set(["shadow", "retired"]),
  shadow: new Set(["canary", "retired"]),
  canary: new Set(["canary", "active", "retired"]),
  active: new Set(["retired"]),
  retired: new Set(["shadow"]),
};

export function transitionConfigInferenceRelease(release, status, {
  operator = "",
  reason = "",
  trafficPercent,
  autoExecutionEnabled = false,
  gate: proposedGate,
  now = Date.now(),
} = {}) {
  const current = text(release?.status, 40);
  const next = text(status, 40);
  const gate = release?.gate;
  if (!RELEASE_TRANSITIONS[current]?.has(next)) throw new Error(`release 不能从 ${current || "unknown"} 变为 ${next}`);
  const actor = text(operator, 200);
  if (!actor) throw new Error("release 状态变更必须记录 operator");
  if (!gate) throw new Error("release 缺少冻结 gate");
  if (proposedGate && gateFingerprint(proposedGate) !== gateFingerprint(gate)) {
    throw new Error("release transition 禁止覆盖冻结 gate");
  }
  if (next === "shadow" && !gate.shadowReady) throw new Error("release 未通过 shadow gate");
  if (next === "canary" && !gate?.canaryReady) throw new Error("release 未通过 canary gate");
  if (next === "active" && !gate?.canaryReady) throw new Error("release 未通过 active gate");
  if (next === "active" && (current !== "canary" || Number(release?.trafficPercent) !== 50)) {
    throw new Error("release 必须完成 5%→25%→50% canary 后才能 active");
  }
  if (autoExecutionEnabled && !gate?.autoExecutionReady) throw new Error("release 未达到自动执行门槛");
  const requestedTraffic = trafficPercent == null
    ? next === "shadow" ? 0 : next === "active" ? 100 : release.trafficPercent
    : Math.max(0, Math.min(100, finite(trafficPercent)));
  if (next === "canary" && ![5, 25, 50].includes(requestedTraffic)) {
    throw new Error("canary 流量只允许 5%、25% 或 50%");
  }
  if (next === "canary") {
    const expectedTraffic = current === "canary"
      ? ({ 5: 25, 25: 50 }[Number(release?.trafficPercent)] || null)
      : 5;
    if (requestedTraffic !== expectedTraffic) {
      throw new Error(`canary 必须按 5%→25%→50% 逐级放量，下一档为 ${expectedTraffic || "无"}`);
    }
  }
  const at = nowIso(now);
  return deepFreeze({
    ...release,
    status: next,
    trafficPercent: next === "retired" ? 0 : requestedTraffic,
    autoExecutionEnabled: next === "active" && autoExecutionEnabled === true,
    gate: release.gate,
    updatedAt: at,
    updatedBy: actor,
    history: [
      ...(Array.isArray(release.history) ? release.history : []),
      {
        from: current,
        to: next,
        trafficPercent: next === "retired" ? 0 : requestedTraffic,
        autoExecutionEnabled: next === "active" && autoExecutionEnabled === true,
        reason: text(reason, 2000),
        at,
        by: actor,
      },
    ],
  });
}

export function activateConfigInferenceRelease(releases = [], releaseId, options = {}) {
  const target = (Array.isArray(releases) ? releases : []).find((row) => row.id === releaseId);
  if (!target) throw new Error("release 不存在");
  const active = transitionConfigInferenceRelease(target, "active", options);
  return releases.map((row) => {
    if (row.id === target.id) return active;
    if (row.projectId === target.projectId && row.status === "active") {
      return transitionConfigInferenceRelease(row, "retired", {
        operator: options.operator,
        reason: options.reason || `由 ${target.id} 替代`,
        now: options.now,
      });
    }
    return row;
  });
}

/**
 * Emergency rollback creates a new immutable active pointer to an artifact that
 * previously completed the full active lifecycle. It never rewrites a retired release.
 */
export function rollbackConfigInferenceRelease(releases = [], targetReleaseId, {
  operator = "",
  reason = "",
  now = Date.now(),
  idFactory = () => `REL_${randomUUID()}`,
} = {}) {
  const rows = Array.isArray(releases) ? releases : [];
  const target = rows.find((row) => row?.id === targetReleaseId);
  if (!target) throw new Error("rollback 目标 release 不存在");
  if (target.status !== "retired") throw new Error("rollback 目标必须是 retired release");
  if (!(target.history || []).some((row) => row?.to === "active")) {
    throw new Error("rollback 目标从未通过完整 canary 并进入 active");
  }
  if (!target.gate?.canaryReady) throw new Error("rollback 目标的冻结 gate 无效");
  const actor = text(operator, 200);
  const rollbackReason = text(reason, 2000);
  if (!actor) throw new Error("rollback 必须记录 operator");
  if (!rollbackReason) throw new Error("rollback 必须记录 reason");
  const currentActive = rows.filter((row) => row?.projectId === target.projectId && row?.status === "active");
  if (currentActive.length !== 1) throw new Error("rollback 要求项目当前恰好有一个 active release");
  const at = nowIso(now);
  const retiredCurrent = transitionConfigInferenceRelease(currentActive[0], "retired", {
    operator: actor,
    reason: `rollback_to:${target.id}; ${rollbackReason}`,
    now,
  });
  const restored = deepFreeze({
    ...cloneValue(target),
    id: text(idFactory(), 160),
    status: "active",
    trafficPercent: 100,
    autoExecutionEnabled: false,
    rollbackOf: currentActive[0].id,
    restoredFromReleaseId: target.id,
    createdAt: at,
    createdBy: actor,
    updatedAt: at,
    updatedBy: actor,
    history: [{
      from: "retired",
      to: "active",
      trafficPercent: 100,
      autoExecutionEnabled: false,
      reason: rollbackReason,
      at,
      by: actor,
      emergencyRollback: true,
      restoredFromReleaseId: target.id,
      replacedReleaseId: currentActive[0].id,
    }],
  });
  return [
    ...rows
      .filter((row) => row.id !== currentActive[0].id)
      .map((row) => cloneValue(row)),
    retiredCurrent,
    restored,
  ];
}
