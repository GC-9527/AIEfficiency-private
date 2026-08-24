"use strict";

const DEFAULT_MISSING_CONFIRMATIONS = 3;
const DEFAULT_DEGRADED_CONFIRMATIONS = 2;

const RUNTIME_EVIDENCE = Object.freeze({
  OWNED_LISTENER: "owned_listener",
  OWNED_PROCESS: "owned_process",
  MISSING: "missing",
  FOREIGN: "foreign",
  UNKNOWN: "unknown",
});

function isOwnedEvidence(value) {
  return value === RUNTIME_EVIDENCE.OWNED_LISTENER || value === RUNTIME_EVIDENCE.OWNED_PROCESS;
}

function isMissingEvidence(value) {
  return value === RUNTIME_EVIDENCE.MISSING || value === RUNTIME_EVIDENCE.FOREIGN;
}

function normalizeRuntimeHealthGeneration(value) {
  const generation = Number(value);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
}

function nextRuntimeHealthGeneration(value) {
  const generation = normalizeRuntimeHealthGeneration(value);
  return generation >= Number.MAX_SAFE_INTEGER ? 1 : generation + 1;
}

function isRuntimeHealthObservationCurrent(observedGeneration, currentGeneration) {
  return normalizeRuntimeHealthGeneration(observedGeneration)
    === normalizeRuntimeHealthGeneration(currentGeneration);
}

function evaluateRuntimeHealth({
  gatewayHttpOk = false,
  webHttpOk = false,
  gatewayEvidence = RUNTIME_EVIDENCE.UNKNOWN,
  webEvidence = RUNTIME_EVIDENCE.UNKNOWN,
  missingStreak = 0,
  missingConfirmations = DEFAULT_MISSING_CONFIRMATIONS,
  degradedStreak = 0,
  degradedConfirmations = DEFAULT_DEGRADED_CONFIRMATIONS,
} = {}) {
  if (gatewayHttpOk && webHttpOk) {
    return {
      kind: "healthy",
      keepRunning: true,
      shouldStop: false,
      nextMissingStreak: 0,
      nextDegradedStreak: 0,
    };
  }

  const failedEvidence = [];
  if (!gatewayHttpOk) failedEvidence.push(gatewayEvidence);
  if (!webHttpOk) failedEvidence.push(webEvidence);

  if (failedEvidence.some((value) => value === RUNTIME_EVIDENCE.UNKNOWN)) {
    return {
      kind: "inconclusive",
      keepRunning: true,
      shouldStop: false,
      nextMissingStreak: 0,
      nextDegradedStreak: 0,
    };
  }

  if (failedEvidence.some(isMissingEvidence)) {
    const threshold = Math.max(1, Number(missingConfirmations) || DEFAULT_MISSING_CONFIRMATIONS);
    const nextMissingStreak = Math.max(0, Number(missingStreak) || 0) + 1;
    return {
      kind: nextMissingStreak >= threshold ? "stopped" : "missing_pending",
      keepRunning: nextMissingStreak < threshold,
      shouldStop: nextMissingStreak >= threshold,
      nextMissingStreak,
      nextDegradedStreak: 0,
    };
  }

  if (failedEvidence.some(isOwnedEvidence)) {
    const threshold = Math.max(1, Number(degradedConfirmations) || DEFAULT_DEGRADED_CONFIRMATIONS);
    const nextDegradedStreak = Math.max(0, Number(degradedStreak) || 0) + 1;
    return {
      kind: nextDegradedStreak >= threshold ? "degraded" : "degraded_pending",
      keepRunning: true,
      shouldStop: false,
      nextMissingStreak: 0,
      nextDegradedStreak,
    };
  }

  return {
    kind: "inconclusive",
    keepRunning: true,
    shouldStop: false,
    nextMissingStreak: 0,
    nextDegradedStreak: 0,
  };
}

function decideStartAction({
  gatewayHttpOk = false,
  webHttpOk = false,
  gatewayEvidence = RUNTIME_EVIDENCE.UNKNOWN,
  webEvidence = RUNTIME_EVIDENCE.UNKNOWN,
} = {}) {
  const evidence = [gatewayEvidence, webEvidence];
  if (evidence.some((value) => value === RUNTIME_EVIDENCE.UNKNOWN)) return "defer";
  if (gatewayHttpOk && webHttpOk) return "adopt_healthy";
  if (evidence.some(isMissingEvidence)) return "launch";
  if (evidence.some(isOwnedEvidence)) {
    return "adopt_degraded";
  }
  return "launch";
}

function cleanScope(value) {
  return String(value || "").trim().slice(0, 160);
}

function resolveSyncScope({
  profileId,
  profileValue,
  profileEnvValue,
  globalEnvValue,
} = {}) {
  const explicit = cleanScope(profileValue)
    || cleanScope(profileEnvValue)
    || cleanScope(globalEnvValue);
  if (explicit) return explicit;
  const profile = cleanScope(profileId);
  if (!profile || profile.toLowerCase() === "production") return "production";
  return cleanScope(`profile:${profile}`) || "production";
}

function evaluateForceReleaseCandidate({
  pid,
  name,
  command,
  managedProfileId,
  protectedPids = [],
  expectedService,
  serviceFingerprintVerified = false,
} = {}) {
  const numericPid = Number(pid || 0);
  if (!Number.isSafeInteger(numericPid) || numericPid <= 4) {
    return { eligible: false, reason: "invalid_or_system_pid" };
  }
  if (new Set((protectedPids || []).map(Number)).has(numericPid)) {
    return { eligible: false, reason: "protected_process" };
  }
  if (managedProfileId) {
    return { eligible: false, reason: "managed_process" };
  }
  if (expectedService !== "gateway" && expectedService !== "web") {
    return { eligible: false, reason: "unsupported_service" };
  }
  if (!serviceFingerprintVerified) {
    return { eligible: false, reason: "unverified_aiefficiency_service" };
  }

  const processName = String(name || "").trim().toLowerCase();
  const processCommand = String(command || "").trim();
  if (processName !== "node" && processName !== "node.exe") {
    return { eligible: false, reason: "unsupported_process" };
  }
  const recognizedCommand = expectedService === "gateway"
    ? /(?:^|[\\/"'\s])server\.js(?:["'\s]|$)/i.test(processCommand)
    : /(?:^|[\\/"'\s])vite\.js(?:["'\s]|$)/i.test(processCommand);
  if (!recognizedCommand) {
    return { eligible: false, reason: "unrecognized_service_command" };
  }
  return { eligible: true, reason: "recognized_unmanaged_node_service" };
}

function normalizeCommandPathText(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/\.bin\/\.\.\//g, "/")
    .toLowerCase();
}

function isAIEfficiencyWebCommand(command, repositoryRoots = []) {
  const commandText = normalizeCommandPathText(command);
  if (!commandText) return false;
  return (repositoryRoots || []).some((root) => {
    const normalizedRoot = normalizeCommandPathText(root).replace(/\/$/, "");
    if (!normalizedRoot) return false;
    return commandText.includes(
      `${normalizedRoot}/web-dashboard/node_modules/vite/bin/vite.js`,
    );
  });
}

function evaluateForceReleaseProfileState({
  configured = false,
  status = "stopped",
  hasFallback = false,
} = {}) {
  const normalizedStatus = String(status || "stopped").trim().toLowerCase();
  if (!configured || normalizedStatus === "repo_missing") {
    return { allowed: false, stopBeforeStart: false, reason: "profile_not_configured" };
  }
  if (normalizedStatus === "starting" || normalizedStatus === "stopping") {
    return { allowed: false, stopBeforeStart: false, reason: "profile_busy" };
  }
  if (!hasFallback) {
    return { allowed: false, stopBeforeStart: false, reason: "fallback_missing" };
  }
  return {
    allowed: true,
    stopBeforeStart: normalizedStatus === "running",
    reason: "recoverable_fallback",
  };
}

function isAIEfficiencyGatewayFingerprint(payload) {
  const data = payload?.data;
  return payload?.ok === true
    && /^[a-f0-9]{12,64}$/i.test(String(data?.id || ""))
    && ["standalone", "server", "client"].includes(String(data?.role || ""))
    && /^https?:\/\/[^/]+:\d+$/i.test(String(data?.host || ""))
    && typeof data?.capacity === "object"
    && Number.isFinite(data?.capacity?.maxConcurrent)
    && typeof data?.syncScope === "string"
    && data.syncScope.length > 0
    && Number.isFinite(data?.sharedVersion)
    && Number.isFinite(data?.ts);
}

module.exports = {
  DEFAULT_DEGRADED_CONFIRMATIONS,
  DEFAULT_MISSING_CONFIRMATIONS,
  RUNTIME_EVIDENCE,
  decideStartAction,
  evaluateForceReleaseCandidate,
  evaluateForceReleaseProfileState,
  evaluateRuntimeHealth,
  isAIEfficiencyGatewayFingerprint,
  isAIEfficiencyWebCommand,
  isRuntimeHealthObservationCurrent,
  nextRuntimeHealthGeneration,
  resolveSyncScope,
};
