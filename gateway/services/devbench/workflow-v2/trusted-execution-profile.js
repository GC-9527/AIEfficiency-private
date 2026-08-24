import { canonicalSha256 } from "./envelope-store.js";
import { buildVerificationEvidenceContract } from "./verification-evidence-contract.js";
import { WORKFLOW_V2_SCHEMA_IDS, workflowV2SchemaRegistry } from "./schema-registry.js";
import {
  WORKFLOW_V2_BUILD_CONTROLLER_ADAPTER_ID,
  WORKFLOW_V2_DEVICE_PROXY_ADAPTER_ID,
} from "./controller-receipt-bridge.js";

const RECEIPT_ACTIONS = Object.freeze(["BUILD", "TEST", "DEVICE_ACTION", "DB_QUERY", "CAPTURE"]);
const PROCESS_ACTIONS = new Set(["BUILD", "TEST"]);
const ADAPTER_ACTIONS = new Set(["DEVICE_ACTION", "DB_QUERY", "CAPTURE"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_EXECUTOR_KEYS = new Set(["command", "script", "shell", "env"]);

function string(value, maxLength = 1000) {
  return Array.from(String(value ?? "").trim()).slice(0, maxLength).join("");
}

function strings(values, { maxItems = 30, maxLength = 500 } = {}) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => string(value, maxLength))
    .filter(Boolean))]
    .slice(0, maxItems);
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key) || FORBIDDEN_EXECUTOR_KEYS.has(key)) throw new Error(`${label} 含不允许字段 ${key}`);
  }
}

function safeId(value, label) {
  const id = string(value, 128);
  if (!SAFE_ID.test(id)) throw new Error(`${label} 不是安全的不透明 ID`);
  return id;
}

function normalizeExecutor(value, rootIds, label) {
  exactKeys(value, new Set([
    "executorId", "action", "argv", "cwdRootId", "timeoutMs", "adapterId", "buildType", "businessAction",
  ]), label);
  const executorId = safeId(value.executorId, `${label}.executorId`);
  const action = string(value.action, 32).toUpperCase();
  if (!RECEIPT_ACTIONS.includes(action)) throw new Error(`${label}.action 不受支持`);
  const cwdRootId = safeId(value.cwdRootId, `${label}.cwdRootId`);
  if (!rootIds.has(cwdRootId)) throw new Error(`${label}.cwdRootId 不在冻结 roots 中`);
  const timeoutMs = Number(value.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1_800_000) {
    throw new Error(`${label}.timeoutMs 必须在 1000..1800000`);
  }
  if (PROCESS_ACTIONS.has(action)) {
    const hasArgv = Array.isArray(value.argv);
    if ((action === "TEST" || hasArgv) && (!hasArgv || value.argv.length < 1 || value.argv.length > 100)) {
      throw new Error(`${label}.argv 必须是非空参数数组`);
    }
    const argv = (hasArgv ? value.argv : []).map((part, index) => {
      const normalized = string(part, 2000);
      if (!normalized || normalized.includes("\u0000")) throw new Error(`${label}.argv[${index}] 非法`);
      return normalized;
    });
    if (value.adapterId != null) throw new Error(`${label} BUILD/TEST 不允许 adapterId`);
    if (action === "BUILD") {
      if (value.businessAction != null) throw new Error(`${label} BUILD 不接受 businessAction`);
      const buildType = string(value.buildType, 20).toLowerCase();
      if (buildType && !["debug", "release"].includes(buildType)) {
        throw new Error(`${label}.buildType 必须是 debug 或 release`);
      }
      if (!argv.length && !buildType) throw new Error(`${label} BUILD 缺少冻结 buildType`);
      return {
        executorId,
        action,
        adapterId: WORKFLOW_V2_BUILD_CONTROLLER_ADAPTER_ID,
        ...(argv.length ? { argv } : {}),
        ...(buildType ? { buildType } : {}),
        cwdRootId,
        timeoutMs,
      };
    }
    if (value.buildType != null || value.businessAction != null) {
      throw new Error(`${label} TEST 不接受 buildType/businessAction`);
    }
    return { executorId, action, argv, cwdRootId, timeoutMs };
  }
  if (!ADAPTER_ACTIONS.has(action)) throw new Error(`${label}.action 不受支持`);
  if (value.argv != null || value.buildType != null) throw new Error(`${label} 内建动作不允许 argv/buildType`);
  if (action === "DEVICE_ACTION") {
    const businessAction = string(value.businessAction, 128);
    if (businessAction) {
      if (value.adapterId != null) throw new Error(`${label} DEVICE_ACTION businessAction 不接受自定义 adapterId`);
      safeId(businessAction, `${label}.businessAction`);
      return {
        executorId,
        action,
        adapterId: WORKFLOW_V2_DEVICE_PROXY_ADAPTER_ID,
        businessAction,
        cwdRootId,
        timeoutMs,
      };
    }
  } else if (value.businessAction != null) {
    throw new Error(`${label} 只有 DEVICE_ACTION 可声明 businessAction`);
  }
  return {
    executorId,
    action,
    adapterId: safeId(value.adapterId, `${label}.adapterId`),
    cwdRootId,
    timeoutMs,
  };
}

function profiles(config) {
  return Array.isArray(config?.workflowV2?.executionProfiles)
    ? config.workflowV2.executionProfiles
    : [];
}

function profileRootId(profile) {
  return string(profile?.rootId || "main", 32);
}

function selectProfile(config, stageId, rootId) {
  const configured = profiles(config);
  const activeProfileId = string(config?.workflowV2?.activeExecutionProfileId, 128);
  const candidates = configured.filter((profile) => {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) return false;
    if (activeProfileId && string(profile.profileId, 128) !== activeProfileId) return false;
    return profileRootId(profile) === rootId && profile.stages?.[stageId];
  });
  if (candidates.length === 1) return { profile: candidates[0], activeProfileId };
  if (candidates.length === 0) {
    return {
      profile: null,
      activeProfileId,
      reason: activeProfileId
        ? `未找到 activeExecutionProfileId=${activeProfileId} 对应的 ${stageId}/${rootId} profile`
        : `未配置唯一的 ${stageId}/${rootId} execution profile`,
    };
  }
  return { profile: null, activeProfileId, reason: `${stageId}/${rootId} execution profile 不唯一` };
}

function blockedResult({ stageId, storyId, rootId, profileId = null, reason }) {
  const blockers = [string(reason, 1000) || "可信 execution profile 不可用"];
  const common = {
    status: "BLOCKED",
    profileId,
    blockers,
    executionProfile: null,
  };
  if (stageId === "VERIFY_EXECUTE") {
    const draft = {
      schemaVersion: "verification-plan-v2",
      profileId,
      status: "BLOCKED",
      storyIds: [storyId],
      mandatoryCapabilities: [],
      blockers,
      cases: [],
    };
    const verificationPlan = { ...draft, planId: `verify-plan-${canonicalSha256(draft).slice(0, 32)}` };
    workflowV2SchemaRegistry.assertValid(
      WORKFLOW_V2_SCHEMA_IDS.verificationPlan,
      verificationPlan,
      "blocked verification plan",
    );
    return { ...common, verificationPlan, localChecks: [] };
  }
  return { ...common, localChecks: [], verificationPlan: null };
}

function normalizeTarget(value, { rootId, deviceProfile, flavorProfile }, label) {
  exactKeys(value || {}, new Set(["rootId", "flavor", "buildType", "deviceProfileId", "environment"]), label);
  const selectedRootId = string(value?.rootId || rootId, 32);
  if (selectedRootId !== rootId) throw new Error(`${label}.rootId 必须匹配 profile rootId`);
  const nullable = (candidate, fallback, maxLength = 120) => {
    const selected = candidate === undefined ? fallback : candidate;
    return selected == null || String(selected).trim() === "" ? null : string(selected, maxLength);
  };
  return {
    rootId: selectedRootId,
    flavor: nullable(value?.flavor, flavorProfile?.flavor, 100),
    buildType: nullable(value?.buildType, flavorProfile?.buildType, 100),
    deviceProfileId: nullable(value?.deviceProfileId, deviceProfile?.profileId, 160),
    environment: nullable(value?.environment, null, 120),
  };
}

function normalizeStageProfile({ profile, stageId, roots }) {
  const rootId = profileRootId(profile);
  const rootIds = new Set(roots.map((root) => string(root.rootId, 32)));
  if (!rootIds.has(rootId)) throw new Error(`profile.rootId=${rootId} 不在冻结 roots 中`);
  const profileId = safeId(profile.profileId, "profile.profileId");
  const stage = profile.stages?.[stageId];
  exactKeys(stage, new Set(stageId === "REPAIR" ? ["executors", "localChecks"] : ["executors", "cases"]), `profile.stages.${stageId}`);
  if (!Array.isArray(stage.executors) || stage.executors.length === 0 || stage.executors.length > 100) {
    throw new Error(`profile.stages.${stageId}.executors 必须是非空数组`);
  }
  const executors = stage.executors.map((value, index) => normalizeExecutor(
    value,
    rootIds,
    `profile.stages.${stageId}.executors[${index}]`,
  ));
  const executorIds = new Set();
  for (const executor of executors) {
    if (executorIds.has(executor.executorId)) throw new Error(`重复 executorId ${executor.executorId}`);
    executorIds.add(executor.executorId);
  }
  return {
    rootId,
    profileId,
    stage,
    executorById: new Map(executors.map((executor) => [executor.executorId, executor])),
    executionProfile: {
      schemaVersion: "workflow-v2-execution-profile-v1",
      profileId,
      rootId,
      stageId,
      executors,
    },
  };
}

function repairChecks(normalized) {
  if (!Array.isArray(normalized.stage.localChecks) || normalized.stage.localChecks.length === 0) {
    throw new Error("REPAIR profile 缺少 localChecks");
  }
  const seen = new Set();
  const checks = normalized.stage.localChecks.map((value, index) => {
    exactKeys(value, new Set(["checkId", "name", "executorId", "mandatory", "rootId"]), `localChecks[${index}]`);
    const checkId = safeId(value.checkId, `localChecks[${index}].checkId`);
    if (seen.has(checkId)) throw new Error(`重复 checkId ${checkId}`);
    seen.add(checkId);
    const executorId = safeId(value.executorId, `localChecks[${index}].executorId`);
    const executor = normalized.executorById.get(executorId);
    if (!executor || !PROCESS_ACTIONS.has(executor.action)) throw new Error(`${checkId} 未绑定 BUILD/TEST executor`);
    const rootId = string(value.rootId || normalized.rootId, 32);
    if (rootId !== normalized.rootId) throw new Error(`${checkId}.rootId 与 profile 不匹配`);
    if (typeof value.mandatory !== "boolean") throw new Error(`${checkId}.mandatory 必须显式提供`);
    const name = string(value.name || checkId, 160);
    if (!name) throw new Error(`${checkId}.name 非法`);
    return { checkId, name, executorId, action: executor.action, mandatory: value.mandatory, rootId };
  });
  if (!checks.some((check) => check.mandatory && PROCESS_ACTIONS.has(check.action))) {
    throw new Error("REPAIR profile 至少需要一个 mandatory BUILD/TEST localCheck");
  }
  return checks;
}

function verificationCases(normalized, { storyId, deviceProfile, flavorProfile }) {
  if (!Array.isArray(normalized.stage.cases) || normalized.stage.cases.length === 0) {
    throw new Error("VERIFY_EXECUTE profile 缺少 cases");
  }
  const seen = new Set();
  const cases = normalized.stage.cases.map((value, index) => {
    exactKeys(value, new Set([
      "caseId", "title", "mandatory", "executorId", "requirements", "target", "preconditions",
      "steps", "assertions", "evidenceRequirements", "cleanup", "failureDiagnostics",
    ]), `cases[${index}]`);
    const caseId = safeId(value.caseId, `cases[${index}].caseId`);
    if (seen.has(caseId)) throw new Error(`重复 caseId ${caseId}`);
    seen.add(caseId);
    const executorId = safeId(value.executorId, `cases[${index}].executorId`);
    const executor = normalized.executorById.get(executorId);
    if (!executor) throw new Error(`${caseId} 未绑定可信 executor`);
    if (typeof value.mandatory !== "boolean") throw new Error(`${caseId}.mandatory 必须显式提供`);
    const steps = strings(value.steps, { maxItems: 50, maxLength: 1000 });
    const assertions = strings(value.assertions, { maxItems: 30, maxLength: 1000 });
    if (!steps.length || !assertions.length) throw new Error(`${caseId} 缺少 steps/assertions`);
    return {
      caseId,
      title: string(value.title, 300),
      storyIds: [storyId],
      mandatory: value.mandatory,
      executorId,
      action: executor.action,
      requirements: strings(value.requirements, { maxItems: 30, maxLength: 500 }),
      target: normalizeTarget(value.target, {
        rootId: normalized.rootId,
        deviceProfile,
        flavorProfile,
      }, `cases[${index}].target`),
      preconditions: strings(value.preconditions, { maxItems: 30, maxLength: 500 }),
      steps,
      assertions,
      evidenceRequirements: strings(value.evidenceRequirements, { maxItems: 30, maxLength: 300 }),
      cleanup: strings(value.cleanup, { maxItems: 20, maxLength: 500 }),
      failureDiagnostics: strings(value.failureDiagnostics, { maxItems: 20, maxLength: 500 }),
    };
  });
  if (!cases.some((entry) => entry.mandatory && entry.storyIds.includes(storyId))) {
    throw new Error(`storyId=${storyId} 没有 mandatory verification case`);
  }
  return cases;
}

export function buildTrustedStageExecution({
  config,
  tab,
  stageId,
  roots = [],
  deviceProfile = null,
  flavorProfile = null,
} = {}) {
  if (!["REPAIR", "VERIFY_EXECUTE"].includes(stageId)) {
    return { status: "READY", profileId: null, blockers: [], executionProfile: null, localChecks: [], verificationPlan: null };
  }
  const storyId = string(tab?.id, 160);
  const mainRoot = roots.find((root) => root.kind === "MAIN") || roots[0];
  const rootId = string(mainRoot?.rootId || "main", 32);
  const selected = selectProfile(config, stageId, rootId);
  if (!selected.profile) return blockedResult({ stageId, storyId, rootId, reason: selected.reason });
  const selectedProfileId = string(selected.profile.profileId, 128) || null;
  try {
    const normalized = normalizeStageProfile({ profile: selected.profile, stageId, roots });
    if (stageId === "REPAIR") {
      return {
        status: "READY",
        profileId: normalized.profileId,
        blockers: [],
        executionProfile: normalized.executionProfile,
        localChecks: repairChecks(normalized),
        verificationPlan: null,
      };
    }
    const cases = verificationCases(normalized, { storyId, deviceProfile, flavorProfile });
    const draft = {
      schemaVersion: "verification-plan-v2",
      profileId: normalized.profileId,
      status: "READY",
      storyIds: [storyId],
      mandatoryCapabilities: [...new Set(cases.filter((entry) => entry.mandatory).map((entry) => entry.action))].sort(),
      blockers: [],
      cases,
    };
    const verificationPlan = {
      ...draft,
      planId: `verify-plan-${canonicalSha256({ draft, executionProfile: normalized.executionProfile }).slice(0, 32)}`,
    };
    workflowV2SchemaRegistry.assertValid(
      WORKFLOW_V2_SCHEMA_IDS.verificationPlan,
      verificationPlan,
      "trusted verification plan",
    );
    const evidenceContract = buildVerificationEvidenceContract(verificationPlan);
    if (!evidenceContract.ok) {
      throw new Error(`${evidenceContract.code}: ${evidenceContract.reason}`);
    }
    return {
      status: "READY",
      profileId: normalized.profileId,
      blockers: [],
      executionProfile: normalized.executionProfile,
      localChecks: [],
      verificationPlan,
    };
  } catch (error) {
    return blockedResult({
      stageId,
      storyId,
      rootId,
      profileId: selectedProfileId,
      reason: `execution profile 无法安全冻结：${error?.message || error}`,
    });
  }
}

export const WORKFLOW_V2_TRUSTED_RECEIPT_ACTIONS = RECEIPT_ACTIONS;
