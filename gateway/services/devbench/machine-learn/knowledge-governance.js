import { randomUUID } from "node:crypto";

export const KNOWLEDGE_VALUE_SCOPES = Object.freeze([
  "global", "project", "environment", "node", "user", "task",
]);
export const SHARED_KNOWLEDGE_SCOPES = Object.freeze(["global", "project", "environment", "task"]);
export const LOCAL_KNOWLEDGE_SCOPES = Object.freeze(["node", "user"]);
const STATUS_FLOW = {
  draft: new Set(["approved", "rejected"]),
  approved: new Set(["active", "rejected"]),
  active: new Set(["retired"]),
  rejected: new Set(),
  retired: new Set(["active"]),
};

function text(value, limit = 4000) {
  return String(value ?? "").trim().slice(0, limit);
}

function list(value = []) {
  return [...new Set((Array.isArray(value) ? value : [value]).map((item) => text(item, 100)).filter(Boolean))];
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function safeKeyId(value) {
  const id = text(value, 160);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(id)) {
    throw new Error("knowledge key id 只能包含字母、数字、点、冒号、下划线和连字符");
  }
  return id;
}

export function knowledgeValueSensitivity(value) {
  const raw = text(value, 20_000);
  const machinePath = /(?:^|[\s=:;,("'[])(?:[a-z]:[\\/]|\\\\|\/(?:home|Users|mnt|Volumes|opt|var\/folders)\/)/i.test(raw)
    || /(?:^|[\\/])Users[\\/][^\\/]+/i.test(raw)
    || /(?:^|[\s=;,(["'])(?:\/(?!\/)[a-z0-9._-]+){2,}(?:\/)?/i.test(raw);
  const secret = /\b(?:token|api[_ -]?key|access[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|private[_ -]?key|secret|password|passwd|pwd|cookie|authorization)["']?\s*[:=]/i.test(raw)
    || /\b(?:Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/i.test(raw)
    || /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(raw);
  return {
    machinePath,
    secret,
    safeForShared: !machinePath && !secret,
  };
}

export function createKnowledgeKey(input = {}, {
  idFactory = () => `K_${randomUUID()}`,
  now = Date.now(),
} = {}) {
  const dimension = text(input.dimension, 80);
  const canonicalKey = text(input.canonicalKey || input.semanticName, 240);
  if (!dimension) throw new Error("knowledge key dimension 不能为空");
  if (!canonicalKey) throw new Error("knowledge key canonicalKey 不能为空");
  if (text(input.defaultValue)) {
    throw new Error("knowledge defaultValue 必须改为受审批的 value revision");
  }
  const keyId = safeKeyId(input.keyId || input.id || idFactory());
  if (!keyId) throw new Error("knowledge key id 无效");
  const scopePolicy = list(input.scopePolicy?.length ? input.scopePolicy : ["project", "environment", "task"])
    .filter((scope) => KNOWLEDGE_VALUE_SCOPES.includes(scope));
  if (!scopePolicy.length) throw new Error("knowledge key 至少允许一个 value scope");
  return {
    keyId,
    canonicalKey,
    aliases: list([...(input.aliases || []), input.legacyLogicalKey]),
    dimension,
    valueType: text(input.valueType || dimension, 80),
    scopePolicy,
    ownerTeam: text(input.ownerTeam, 160),
    sensitivity: text(input.sensitivity || "internal", 40),
    status: text(input.status || "active", 40),
    createdAt: text(input.createdAt) || nowIso(now),
    createdBy: text(input.createdBy, 200),
  };
}

function revisionIdentity(keyId, scope, scopeId, revision) {
  return `${keyId}:${scope}:${encodeURIComponent(scopeId || "_")}:r${revision}`;
}

function scopeRevisions(revisions, keyId, scope, scopeId) {
  return (Array.isArray(revisions) ? revisions : []).filter((row) => (
    text(row.keyId) === keyId
    && text(row.scope) === scope
    && text(row.scopeId) === scopeId
  ));
}

export function createKnowledgeValueRevision(key, revisions = [], input = {}, {
  operator = "",
  now = Date.now(),
} = {}) {
  const keyId = text(key?.keyId || key?.id, 160);
  if (!keyId) throw new Error("knowledge key 不存在");
  const scope = text(input.scope || "project", 40);
  const scopeId = text(input.scopeId, 240);
  if (!KNOWLEDGE_VALUE_SCOPES.includes(scope)) throw new Error(`不支持的 value scope：${scope}`);
  if (!list(key.scopePolicy).includes(scope)) throw new Error(`knowledge key 不允许 ${scope} scope`);
  if (scope !== "global" && !scopeId) throw new Error(`${scope} scope 必须提供 scopeId`);
  const actualValue = text(input.actualValue ?? input.value, 20_000);
  if (!actualValue) throw new Error("actualValue 不能为空");
  const reason = text(input.reason, 2000);
  if (!reason) throw new Error("value revision 必须填写修改原因");
  const sensitivity = knowledgeValueSensitivity(actualValue);
  if (SHARED_KNOWLEDGE_SCOPES.includes(scope) && !sensitivity.safeForShared) {
    throw new Error(sensitivity.secret
      ? "共享 value 禁止保存 token、Cookie、密码或 secret"
      : "共享 value 禁止保存本机绝对路径；请使用 node/user binding");
  }
  const rows = scopeRevisions(revisions, keyId, scope, scopeId);
  const latestRevision = Math.max(0, ...rows.map((row) => Number(row.revision) || 0));
  const expectedRevision = Math.max(0, Math.trunc(Number(input.expectedRevision) || 0));
  if (expectedRevision !== latestRevision) {
    const error = new Error(`value revision 冲突：期望 ${expectedRevision}，当前 ${latestRevision}`);
    error.code = "KNOWLEDGE_VALUE_REVISION_CONFLICT";
    error.statusCode = 409;
    throw error;
  }
  const revision = latestRevision + 1;
  return {
    id: revisionIdentity(keyId, scope, scopeId, revision),
    keyId,
    scope,
    scopeId,
    actualValue,
    revision,
    parentRevision: latestRevision,
    status: "draft",
    storage: LOCAL_KNOWLEDGE_SCOPES.includes(scope) ? "local" : "shared",
    reason,
    createdAt: nowIso(now),
    createdBy: text(operator || input.createdBy, 200),
    sensitivity,
  };
}

export function transitionKnowledgeValueRevision(row, status, {
  operator = "",
  reason = "",
  now = Date.now(),
} = {}) {
  const current = text(row?.status, 40);
  const next = text(status, 40);
  if (!STATUS_FLOW[current]?.has(next)) throw new Error(`value revision 不能从 ${current || "unknown"} 变为 ${next}`);
  const actor = text(operator, 200);
  if (!actor) throw new Error("value revision 状态变更必须记录 operator");
  const patch = {
    ...row,
    status: next,
    statusReason: text(reason, 2000),
    updatedAt: nowIso(now),
    updatedBy: actor,
  };
  if (next === "approved") {
    patch.approvedAt = patch.updatedAt;
    patch.approvedBy = actor;
  } else if (next === "active") {
    patch.activatedAt = patch.updatedAt;
    patch.activatedBy = actor;
  } else if (next === "retired") {
    patch.retiredAt = patch.updatedAt;
    patch.retiredBy = actor;
  }
  return patch;
}

export function activateKnowledgeValueRevision(revisions = [], revisionId, options = {}) {
  const source = Array.isArray(revisions) ? revisions : [];
  const selected = source.find((row) => text(row.id) === text(revisionId));
  if (!selected) throw new Error("value revision 不存在");
  if (!["approved", "retired"].includes(selected.status)) throw new Error("只有 approved/retired revision 可以激活");
  const now = options.now || Date.now();
  return source.map((row) => {
    if (row.keyId !== selected.keyId || row.scope !== selected.scope || text(row.scopeId) !== text(selected.scopeId)) return row;
    if (row.id === selected.id) return transitionKnowledgeValueRevision(row, "active", { ...options, now });
    if (row.status === "active") return transitionKnowledgeValueRevision(row, "retired", {
      ...options,
      now,
      reason: options.reason || `由 ${selected.id} 替代`,
    });
    return row;
  });
}

export function rollbackKnowledgeValueRevision(revisions = [], {
  keyId,
  scope,
  scopeId = "",
  targetRevision,
  operator,
  reason,
  now = Date.now(),
} = {}) {
  const selected = (Array.isArray(revisions) ? revisions : []).find((row) => (
    text(row.keyId) === text(keyId)
    && text(row.scope) === text(scope)
    && text(row.scopeId) === text(scopeId)
    && Number(row.revision) === Number(targetRevision)
  ));
  if (!selected) throw new Error("回滚目标 revision 不存在");
  if (!["active", "retired", "approved"].includes(selected.status)) throw new Error("回滚目标尚未批准");
  return activateKnowledgeValueRevision(revisions, selected.id, { operator, reason, now });
}

const RESOLUTION_ORDER = ["task", "node", "user", "environment", "project", "global"];

export function resolveKnowledgeValue(key, revisions = [], context = {}) {
  if (text(key?.status || "active").toLowerCase() !== "active") {
    return {
      resolved: false,
      keyId: text(key?.keyId),
      actualValue: "",
      scope: "",
      scopeId: "",
      revision: 0,
      revisionId: "",
      storage: "",
      reason: "knowledge_key_inactive",
    };
  }
  const ids = {
    task: text(context.taskId),
    node: text(context.nodeId),
    user: text(context.userId),
    environment: text(context.environmentId),
    project: text(context.projectId),
    global: "",
  };
  for (const scope of RESOLUTION_ORDER) {
    const scopeId = ids[scope];
    if (scope !== "global" && !scopeId) continue;
    const active = (Array.isArray(revisions) ? revisions : [])
      .filter((row) => row.keyId === key?.keyId && row.scope === scope && text(row.scopeId) === scopeId && row.status === "active")
      .sort((left, right) => Number(right.revision) - Number(left.revision))[0];
    if (active) return {
      resolved: true,
      keyId: key.keyId,
      actualValue: active.actualValue,
      scope,
      scopeId,
      revision: active.revision,
      revisionId: active.id,
      storage: active.storage,
    };
  }
  return {
    resolved: false,
    keyId: text(key?.keyId),
    actualValue: "",
    scope: "",
    scopeId: "",
    revision: 0,
    revisionId: "",
    storage: "",
    reason: "active_value_missing",
  };
}

export function knowledgeValueImpact(revisions = [], {
  keyId,
  sampleReferences = [],
  activeRuns = [],
} = {}) {
  const rows = (Array.isArray(revisions) ? revisions : []).filter((row) => row.keyId === keyId);
  const samples = (Array.isArray(sampleReferences) ? sampleReferences : []).filter((row) => (
    row.keyId === keyId || (Array.isArray(row.keyIds) && row.keyIds.includes(keyId))
  ));
  const runs = (Array.isArray(activeRuns) ? activeRuns : []).filter((row) => (
    row.keyId === keyId || (Array.isArray(row.keyIds) && row.keyIds.includes(keyId))
  ));
  return {
    keyId,
    revisions: rows.length,
    activeRevisions: rows.filter((row) => row.status === "active").length,
    sampleCount: samples.length,
    activeRunCount: runs.length,
    affectedIds: {
      samples: samples.map((row) => row.id).filter(Boolean).slice(0, 100),
      runs: runs.map((row) => row.id).filter(Boolean).slice(0, 100),
    },
  };
}
