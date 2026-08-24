import { createHash } from "node:crypto";
import { storyTicketIdentities as normalizedTicketIdentities } from "./story-ticket-identity.js";

const SCOPE_VERSION = 4;
const REVIEW_DECISIONS = new Set(["correct", "corrected", "insufficient", "ticket_wrong"]);
const CREATE_ENTRY_KINDS = new Set(["blank_story", "story_copy", "task_story", "git_commit"]);
export const DEFAULT_STORY_AI_REVIEW_TTL_MS = 60 * 60 * 1000;
export const MAX_STORY_AI_REVIEW_TTL_MS = 60 * 60 * 1000;

const text = (value) => String(value ?? "").trim();
const list = (value) => (Array.isArray(value) ? value : []);

export function storyAiReviewTtlMs(configured) {
  const value = Number(configured);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_STORY_AI_REVIEW_TTL_MS;
  return Math.max(1, Math.min(MAX_STORY_AI_REVIEW_TTL_MS, Math.trunc(value)));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function digest(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function normalizedRevision(value) {
  return text(value).replace(/^git:/i, "").toLowerCase();
}

function normalizedTicketBinding(ticket = {}) {
  const identities = normalizedTicketIdentities(ticket);
  const source = ticket && typeof ticket === "object" ? ticket : {};
  const bound = source.ticketBound === true
    || source.inputProvided === true
    || (source.ticketBound !== false && source.inputProvided !== false && identities.length > 0);
  return { bound, identities };
}

function ticketIdentityFields(identities = [], ticketBound = false) {
  const normalized = [...new Set(list(identities).map(text).filter(Boolean))];
  return {
    ticketBound: ticketBound === true,
    ...(normalized.length ? {
      ticketIdentity: normalized[0],
      ticketIdentities: normalized,
    } : {}),
  };
}

function normalizedTaskEntry(entry = {}, fallback = {}) {
  const taskId = text(entry.taskId || entry.id);
  // task/group/team 的 TB 身份只能来自该 entry 自身。不能把推理请求的顶层 ticket
  // 回填给所有任务，否则同一 taskId 可以在最终初始化时静默换成另一张 TB 单。
  const ticketIdentities = normalizedTicketIdentities(entry);
  const ticketBound = ticketIdentities.length > 0 || entry.ticketBound === true;
  const ticketIdentity = ticketIdentities[0] || "";
  const normalizedTaskId = ticketIdentity.startsWith("tb-task:")
    ? ticketIdentity.slice("tb-task:".length)
    : "";
  const legacyTaskId = ticketIdentity ? "" : text(entry.tbTaskId || entry.ticketId);
  const tbTaskId = normalizedTaskId || legacyTaskId;
  const title = text(entry.title || fallback.title);
  return {
    kind: "task_story",
    ticketBound,
    ...(taskId ? { taskId } : {}),
    ...(tbTaskId ? { tbTaskId } : {}),
    ...(ticketIdentity ? { ticketIdentity } : {}),
    ...(ticketIdentities.length ? { ticketIdentities } : {}),
    ...(title ? { title } : {}),
  };
}

function normalizeCreateEntry(entry = {}, fallback = {}) {
  const kind = text(entry.kind);
  if (kind === "blank_story") {
    const title = text(entry.title || fallback.title);
    return title ? {
      kind,
      title,
      ...ticketIdentityFields(fallback.ticketIdentities, fallback.ticketBound),
    } : null;
  }
  if (kind === "story_copy") {
    const title = text(entry.title || fallback.title);
    const copyFromId = text(entry.copyFromId);
    if (!title || !copyFromId) return null;
    return {
      kind,
      title,
      copyFromId,
      copyFromKind: text(entry.copyFromKind) || "open",
      ...ticketIdentityFields(fallback.ticketIdentities, fallback.ticketBound),
    };
  }
  if (kind === "task_story") {
    const normalized = normalizedTaskEntry(entry, fallback);
    return normalized.taskId || normalized.tbTaskId || normalized.ticketIdentity || normalized.title
      ? normalized
      : null;
  }
  if (kind === "git_commit") {
    const revision = normalizedRevision(entry.revision || fallback.revision || fallback.ticketId);
    const repositoryId = text(entry.repositoryId || fallback.repositoryId);
    const title = text(entry.title || fallback.title);
    if (!revision) return null;
    return {
      kind,
      revision,
      ...(repositoryId ? { repositoryId } : {}),
      ...(title ? { title } : {}),
      ...ticketIdentityFields(fallback.ticketIdentities, fallback.ticketBound),
    };
  }
  return null;
}

function inferredCreateEntries(storyEntry = {}, ticket = {}, trigger = "") {
  const entry = storyEntry && typeof storyEntry === "object" ? storyEntry : {};
  const fallback = {
    title: text(ticket.title),
    ticketId: text(ticket.tbTaskId || ticket.ticketId),
    ticketBound: ticket.ticketBound !== false && ticket.inputProvided !== false
      && (ticket.ticketBound === true || normalizedTicketIdentities(ticket).length > 0),
    ticketIdentities: normalizedTicketIdentities(ticket),
  };
  const explicit = list(entry.createEntries)
    .map((row) => normalizeCreateEntry(row, fallback))
    .filter(Boolean);
  if (explicit.length) return explicit;

  if (CREATE_ENTRY_KINDS.has(text(entry.kind))) {
    const normalized = normalizeCreateEntry(entry, fallback);
    return normalized ? [normalized] : [];
  }
  if (entry.kind === "story_initialization") {
    const body = entry.body && typeof entry.body === "object" ? entry.body : {};
    if (body.copyFromId) {
      const normalized = normalizeCreateEntry({
        kind: "story_copy",
        title: body.title,
        copyFromId: body.copyFromId,
        copyFromKind: body.copyFromKind,
      }, fallback);
      return normalized ? [normalized] : [];
    }
    if (entry.task) return [normalizedTaskEntry(entry.task, { title: body.title || fallback.title })];
    const normalized = normalizeCreateEntry({ kind: "blank_story", title: body.title }, fallback);
    return normalized ? [normalized] : [];
  }
  if (entry.kind === "task" || entry.kind === "team_dev") {
    return entry.task ? [normalizedTaskEntry(entry.task, fallback)] : [];
  }
  if (entry.kind === "task_group") {
    return list(entry.items).map((row) => normalizedTaskEntry(row)).filter((row) => (
      row.taskId || row.tbTaskId || row.ticketIdentity || row.title
    ));
  }
  if (text(trigger) === "git_commit_story_entry" && /^git:/i.test(text(ticket.ticketId))) {
    return [normalizeCreateEntry({ kind: "git_commit", revision: ticket.ticketId }, fallback)].filter(Boolean);
  }
  return [];
}

function uniqueEntries(entries) {
  const seen = new Set();
  return entries.flatMap((entry) => {
    const fingerprint = digest(entry);
    if (seen.has(fingerprint)) return [];
    seen.add(fingerprint);
    return [{ ...entry, entryFingerprint: fingerprint }];
  });
}

function consumerForEntries(entries) {
  return entries.every((entry) => entry.kind === "git_commit") ? "git_commit_story" : "tabs";
}

function allowedTriggersForEntryKind(entryKind, entries = []) {
  const kinds = new Set(list(entries).map((entry) => text(entry?.kind)).filter(Boolean));
  if (entryKind === "git_commit") return new Set(["git_commit_story_entry"]);
  if (entryKind === "task_group") return new Set(["task_group_execute"]);
  if (entryKind === "team_dev") return new Set(["task_team_execute"]);
  if (entryKind === "task") return new Set(["task_execute", "task_execute_again"]);
  if (entryKind === "story_initialization_panel") {
    if (kinds.has("git_commit")) return new Set(["git_commit_story_entry"]);
    if (kinds.has("story_copy")) return new Set(["story_copied"]);
    return new Set(["story_created"]);
  }
  if (entryKind === "story_initialization") {
    if (kinds.has("git_commit")) return new Set(["git_commit_story_entry"]);
    if (kinds.has("task_story")) return new Set(["story_initialization", "tb_story_created", "story_created"]);
    if (kinds.has("story_copy")) return new Set(["story_initialization", "story_copied"]);
    return new Set(["story_initialization", "story_created", "tb_story_created"]);
  }
  if (entryKind === "git_commit") return new Set(["git_commit_story_entry"]);
  if (entryKind === "story_copy") return new Set(["story_initialization", "story_copied"]);
  if (entryKind === "blank_story") return new Set(["story_initialization", "story_created", "tb_story_created"]);
  if (entryKind === "task_story") {
    return new Set([
      "story_initialization",
      "story_created",
      "tb_story_created",
      "task_execute",
      "task_execute_again",
      "task_team_execute",
      "task_group_execute",
    ]);
  }
  return new Set();
}

function validScopeEntryTrigger(entryKind, trigger, entries) {
  return allowedTriggersForEntryKind(text(entryKind), entries).has(text(trigger));
}

function invalid(code, error, statusCode = 409) {
  return { ok: false, statusCode, code, error };
}

export function createStoryCreateReviewScope({ storyEntry, ticket, projectId, trigger } = {}, {
  ownerId,
  now = Date.now(),
} = {}) {
  const stableOwnerId = text(ownerId);
  const stableProjectId = text(projectId || ticket?.projectId);
  const stableTrigger = text(trigger);
  if (!stableOwnerId || !stableProjectId || !stableTrigger) {
    return invalid(
      "STORY_CREATE_SCOPE_INVALID",
      "创建故事点的 AI 推理必须绑定稳定用户、项目和入口 trigger",
      400,
    );
  }
  const entries = uniqueEntries(inferredCreateEntries(storyEntry, ticket, stableTrigger));
  if (!entries.length) return { ok: true, data: null };
  const entryKind = text(storyEntry?.kind);
  const evidenceTicket = normalizedTicketBinding(ticket);
  const taskEvidenceMustMatch = [
    "task",
    "task_story",
    "story_initialization",
    "story_initialization_panel",
    "task_group",
    "team_dev",
  ].includes(entryKind);
  if (taskEvidenceMustMatch && entries[0]?.kind === "task_story") {
    const entryIdentities = entryTicketIdentities(entries[0]);
    const entryBound = entries[0].ticketBound === true;
    if (entryBound !== evidenceTicket.bound
      || (entryBound && !ticketIdentitiesCompatible(entryIdentities, evidenceTicket.identities))) {
      return invalid(
        "STORY_CREATE_SCOPE_TICKET_MISMATCH",
        "单任务创建入口与本次 AI 推理实际读取的 TB 工单不一致，请刷新任务后重新推理",
        409,
      );
    }
  }
  if (!validScopeEntryTrigger(entryKind, stableTrigger, entries)) {
    return invalid(
      "STORY_CREATE_AI_REVIEW_TRIGGER_MISMATCH",
      `创建入口 ${entryKind || "unknown"} 不能使用配置推理 trigger ${stableTrigger}`,
      409,
    );
  }
  const ticketTitle = text(ticket?.title);
  if (ticketTitle && entries.some((entry) => (
    ["blank_story", "story_copy"].includes(entry.kind) && entry.title !== ticketTitle
  ))) {
    return invalid(
      "STORY_CREATE_SCOPE_MISMATCH",
      "创建范围中的故事点标题与本次 AI 推理标题不一致",
      409,
    );
  }
  const consumer = consumerForEntries(entries);
  if (consumer === "tabs" && entries.some((entry) => entry.kind === "git_commit")) {
    return invalid("STORY_CREATE_SCOPE_INVALID", "同一次 AI 推理不能混用普通故事点与 Git commit 创建入口", 400);
  }
  const scopeFingerprint = digest({
    version: SCOPE_VERSION,
    kind: "story_create",
    consumer,
    projectId: stableProjectId,
    trigger: stableTrigger,
    entryKind,
    evidenceTicketBound: evidenceTicket.bound,
    evidenceTicketIdentities: evidenceTicket.identities,
    entries: entries.map((entry) => entry.entryFingerprint),
  });
  return {
    ok: true,
    data: {
      version: SCOPE_VERSION,
      kind: "story_create",
      consumer,
      ownerId: stableOwnerId,
      projectId: stableProjectId,
      trigger: stableTrigger,
      entryKind,
      evidenceTicketBound: evidenceTicket.bound,
      evidenceTicketIdentities: evidenceTicket.identities,
      entries,
      scopeFingerprint,
      issuedAt: Number(now) || Date.now(),
    },
  };
}

function normalizedRequestedEntry(entry = {}, { title, ticket, ticketId } = {}) {
  const rawKind = text(entry.kind);
  const inferredKind = rawKind === "manual" || !rawKind ? "blank_story" : rawKind;
  const requestedTicket = ticket && typeof ticket === "object"
    ? ticket
    : { ticketId, title };
  return normalizeCreateEntry({ ...entry, kind: inferredKind }, {
    title,
    ticketId,
    ticketBound: requestedTicket.ticketBound !== false && requestedTicket.inputProvided !== false
      && (requestedTicket.ticketBound === true || normalizedTicketIdentities(requestedTicket).length > 0),
    ticketIdentities: normalizedTicketIdentities(requestedTicket),
  });
}

function entryTicketIdentities(entry = {}) {
  return [...new Set([
    ...list(entry?.ticketIdentities),
    entry?.ticketIdentity,
    ...(entry?.kind === "task_story" ? normalizedTicketIdentities({ tbTaskId: entry?.tbTaskId }) : []),
  ].map(text).filter(Boolean))];
}

function ticketIdentitiesCompatible(left = [], right = []) {
  const a = [...new Set(list(left).map(text).filter(Boolean))];
  const b = [...new Set(list(right).map(text).filter(Boolean))];
  const aTask = a.find((value) => value.startsWith("tb-task:"));
  const bTask = b.find((value) => value.startsWith("tb-task:"));
  if (aTask && bTask) return aTask === bTask;
  return a.some((value) => b.includes(value));
}

function createEntryBusinessPayload(entry = {}) {
  const payload = Object.fromEntries(Object.entries(entry || {}).filter(([key]) => ![
    "entryFingerprint",
    "ticketIdentity",
    "ticketIdentities",
  ].includes(key)));
  if (entry.kind === "task_story" && text(entry.ticketIdentity)) delete payload.tbTaskId;
  return payload;
}

function createEntryBusinessMatches(left, right) {
  return digest(createEntryBusinessPayload(left)) === digest(createEntryBusinessPayload(right));
}

function requestedEntryTicketMatches(scopeEntry, requested, ticket, title) {
  const scopedIdentities = entryTicketIdentities(scopeEntry);
  const serverIdentities = normalizedTicketIdentities(ticket);
  const scopedBound = scopeEntry?.ticketBound === true;
  const requestedBound = requested?.ticketBound === true;
  const serverBound = ticket?.ticketBound === true
    || ticket?.inputProvided === true
    || (ticket?.ticketBound !== false && ticket?.inputProvided !== false && serverIdentities.length > 0);
  if (scopedBound !== serverBound || requestedBound !== serverBound) return false;
  if (!serverBound) return !scopedIdentities.length && !serverIdentities.length;
  if (!scopedIdentities.length || !serverIdentities.length) return false;
  if (requested.kind === "task_story") {
    // task 的最终 ticketInput 必须确实由服务端解析为 TB task。只靠标题里的 CARB
    // 不代表用户仍绑定了工单，清空 ticketInput 时必须 fail closed。
    if (!serverIdentities.some((identity) => identity.startsWith("tb-task:"))) return false;
    const requestedIdentities = entryTicketIdentities(requested);
    if (!requestedIdentities.length) return false;
    return ticketIdentitiesCompatible(scopedIdentities, serverIdentities)
      && ticketIdentitiesCompatible(requestedIdentities, serverIdentities);
  }
  return ticketIdentitiesCompatible(scopedIdentities, serverIdentities);
}

export function validateStoryCreateReviewScope(scope, {
  ownerId,
  projectId,
  trigger,
  consumer,
} = {}) {
  if (!scope || Number(scope.version) !== SCOPE_VERSION
    || scope.kind !== "story_create" || !Array.isArray(scope.entries) || !scope.entries.length) {
    return invalid("STORY_CREATE_AI_REVIEW_REQUIRED", "本次推理没有服务端签发的故事点创建范围");
  }
  if (text(scope.ownerId) !== text(ownerId)) {
    return invalid("STORY_CREATE_AI_REVIEW_OWNER_MISMATCH", "本次人工复核不属于当前登录用户", 403);
  }
  if (text(scope.projectId) !== text(projectId)) {
    return invalid("STORY_CREATE_AI_REVIEW_PROJECT_MISMATCH", "人工复核项目与本次故事点创建不一致");
  }
  if (text(scope.trigger) !== text(trigger)) {
    return invalid("STORY_CREATE_AI_REVIEW_TRIGGER_MISMATCH", "人工复核入口绑定已经损坏");
  }
  if (consumer && text(scope.consumer) !== text(consumer)) {
    return invalid("STORY_CREATE_AI_REVIEW_CONSUMER_MISMATCH", "人工复核证明不属于当前故事点创建入口");
  }
  if (!validScopeEntryTrigger(scope.entryKind, scope.trigger, scope.entries)) {
    return invalid("STORY_CREATE_AI_REVIEW_TRIGGER_MISMATCH", "人工复核证明的业务入口与 trigger 不一致");
  }
  const expectedScopeFingerprint = digest({
    version: SCOPE_VERSION,
    kind: "story_create",
    consumer: scope.consumer,
    projectId: scope.projectId,
    trigger: scope.trigger,
    entryKind: scope.entryKind,
    evidenceTicketBound: scope.evidenceTicketBound === true,
    evidenceTicketIdentities: list(scope.evidenceTicketIdentities).map(text).filter(Boolean),
    entries: scope.entries.map((row) => text(row?.entryFingerprint)),
  });
  if (expectedScopeFingerprint !== text(scope.scopeFingerprint)
    || scope.entries.some((row) => digest(Object.fromEntries(
      Object.entries(row || {}).filter(([key]) => key !== "entryFingerprint"),
    )) !== text(row?.entryFingerprint))) {
    return invalid("STORY_CREATE_AI_REVIEW_SCOPE_INVALID", "人工复核的创建范围完整性校验失败");
  }
  return { ok: true, scope };
}

export function validateStoryCreateReviewRun(run, {
  ownerId,
  projectId,
  consumer,
  entry,
  title,
  ticket,
  ticketId,
  now = Date.now(),
  ttlMs,
} = {}) {
  // runId 本身不是授权。最终写入必须重新核对服务端冻结的 owner、入口、业务对象、
  // 人工决定、规则新鲜度和 TTL；这样初始化 intent 也不能延长或跨入口复用旧 run。
  const scope = run?.createScope;
  const stableOwnerId = text(ownerId);
  const scoped = validateStoryCreateReviewScope(scope, {
    ownerId: stableOwnerId,
    projectId,
    trigger: run?.trigger,
    consumer,
  });
  if (!scoped.ok) return scoped;
  if (text(run.projectId) !== text(projectId)) {
    return invalid("STORY_CREATE_AI_REVIEW_PROJECT_MISMATCH", "人工复核项目与本次故事点创建不一致");
  }
  const currentEvidenceTicket = normalizedTicketBinding(run.ticket);
  if (currentEvidenceTicket.bound !== (scope.evidenceTicketBound === true)
    || digest(currentEvidenceTicket.identities) !== digest(list(scope.evidenceTicketIdentities))) {
    return invalid(
      "STORY_CREATE_AI_REVIEW_SCOPE_INVALID",
      "AI 推理读取的 TB 工单证据与服务端签发范围不一致，请重新推理",
    );
  }
  const review = run.review;
  const decision = text(review?.decision);
  if (!review || !REVIEW_DECISIONS.has(decision)) {
    return invalid(
      "STORY_CREATE_AI_REVIEW_REQUIRED",
      "请先保存人工复核结论；暂不采用、信息不足或工单错误也必须保存后才能继续",
    );
  }
  if (text(review.reviewer) !== stableOwnerId) {
    return invalid("STORY_CREATE_AI_REVIEW_OWNER_MISMATCH", "本次人工复核不属于当前登录用户", 403);
  }
  const reviewedAt = Number(review.reviewedAt || 0);
  const effectiveTtl = Math.max(1, Number(ttlMs) || 1);
  if (!reviewedAt || reviewedAt < Number(scope.issuedAt || 0)
    || Number(now) - reviewedAt > effectiveTtl) {
    return invalid("STORY_CREATE_AI_REVIEW_EXPIRED", "人工复核证明已过期，请重新推理并复核");
  }
  if (run.stalePrediction === true) {
    return invalid("STORY_CREATE_AI_REVIEW_STALE", "推理规则或配置已经变化，请重新推理并复核");
  }
  const requested = normalizedRequestedEntry(entry, { title, ticket, ticketId });
  if (!requested) {
    return invalid("STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH", "本次故事点创建缺少可验证的入口身份");
  }
  if (requested.kind === "task_story" && text(requested.title) !== text(title)) {
    return invalid("STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH", "任务故事点标题与初始化面板最终标题不一致");
  }
  const matchedScopeEntry = scope.entries.find((row) => (
    createEntryBusinessMatches(row, requested)
    && requestedEntryTicketMatches(row, requested, ticket, title)
  ));
  if (!matchedScopeEntry) {
    return invalid("STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH", "人工复核证明未绑定当前故事点标题、TB 工单身份、任务或复制来源");
  }
  return {
    ok: true,
    decision,
    scope,
    reviewedAt,
    expiresAt: reviewedAt + effectiveTtl,
    entry: requested,
    scopeEntry: matchedScopeEntry,
  };
}
