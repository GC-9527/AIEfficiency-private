import { readFileSync } from "node:fs";
import {
  canonicalJson,
  canonicalSha256,
  workflowV2EnvelopeStore,
} from "./envelope-store.js";
import {
  WORKFLOW_V2_SCHEMA_IDS,
  workflowV2SchemaRegistry,
} from "./schema-registry.js";

const DEFAULT_BUDGET_CONFIG = JSON.parse(readFileSync(new URL("./context-budget.json", import.meta.url), "utf8"));

const REQUIRED_BUDGET_FIELDS = Object.freeze([
  "task.instruction",
  "task.successCriteria",
  "data.issue",
  "data.latestSubstantiveComments",
  "checkpoint",
  "data.evidenceManifest",
  "data.relevantMemory",
  "data.approvedPlanOrPriorResult",
  "data.misc",
]);

const RAW_HISTORY_KEYS = new Set([
  "aiprompt",
  "assistant",
  "assistanthistory",
  "assistantmessages",
  "conversation",
  "conversationhistory",
  "history",
  "messages",
  "modelhistory",
  "promptoverride",
  "rawassistanthistory",
  "rawhistory",
  "systemprompt",
  "transcript",
]);

const OMIT_UNTRUSTED_VALUE = Symbol("omit-untrusted-value");
const RAW_HISTORY_ROLES = new Set(["assistant", "developer", "model", "system", "tool"]);

const CONTROL_KEYS = new Set([
  "capabilities",
  "contextId",
  "idempotencyKey",
  "maxChars",
  "output",
  "outputPath",
  "revision",
  "scope",
  "stage",
  "story",
  "task",
  "verifiedEvidenceIds",
]);

const STAGE_DATA_FIELDS = Object.freeze({
  TRIAGE: Object.freeze([
    "issue",
    "latestSubstantiveComments",
    "evidenceManifest",
    "requiredEvidence",
    "relevantMemory",
    "paths",
    "misc",
  ]),
  DIAGNOSE_PLAN: Object.freeze([
    "issue",
    "latestSubstantiveComments",
    "evidenceManifest",
    "requiredEvidence",
    "relevantMemory",
    "paths",
    "approvedPlan",
    "approvedPlanOrPriorResult",
    "priorStageResult",
    "misc",
  ]),
  REPAIR: Object.freeze([
    "approvedPlan",
    "approvedPlanOrPriorResult",
    "priorStageResult",
    "triageResult",
    "evidenceManifest",
    "requiredEvidence",
    "paths",
    "currentDiff",
    "localChecks",
    "misc",
  ]),
  INDEPENDENT_REVIEW: Object.freeze([
    "approvedPlan",
    "approvedPlanOrPriorResult",
    "priorStageResult",
    "repairResult",
    "evidenceManifest",
    "requiredEvidence",
    "paths",
    "currentDiff",
    "localChecks",
    "misc",
  ]),
  VERIFY_PLAN: Object.freeze([
    "approvedPlan",
    "approvedPlanOrPriorResult",
    "priorStageResult",
    "repairResult",
    "verificationPlan",
    "evidenceManifest",
    "requiredEvidence",
    "paths",
    "currentDiff",
    "localChecks",
    "flavorProfile",
    "deviceProfile",
    "misc",
  ]),
  VERIFY_EXECUTE: Object.freeze([
    "approvedPlan",
    "approvedPlanOrPriorResult",
    "priorStageResult",
    "repairResult",
    "verificationPlan",
    "evidenceManifest",
    "requiredEvidence",
    "paths",
    "currentDiff",
    "localChecks",
    "flavorProfile",
    "deviceProfile",
    "misc",
  ]),
  REPORT_SHORT: Object.freeze(["reportFacts", "maxChars"]),
  REPORT_EXPERT: Object.freeze(["reportFacts", "assetManifest", "outputPath", "verifiedEvidenceIds"]),
  MEMORY_DISTILL: Object.freeze([
    "evidenceManifest",
    "requiredEvidence",
    "relevantMemory",
    "reportFacts",
    "misc",
  ]),
});

const EVIDENCE_METADATA_FIELDS = Object.freeze([
  "preprocessedRefs",
  "sizeBytes",
  "sha256",
]);

const AVAILABILITY_RANK = Object.freeze({
  AVAILABLE: 0,
  PARTIAL: 1,
  MISSING: 2,
  UNSUPPORTED: 3,
  FORBIDDEN: 4,
  CORRUPTED: 5,
});

const COVERAGE_RANK = Object.freeze({ COMPLETE: 0, PARTIAL: 1, UNKNOWN: 2 });

export class WorkflowV2ContextSelectionError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WorkflowV2ContextSelectionError";
    this.code = code;
    this.details = details;
  }
}

function fail(message, code, details = {}) {
  throw new WorkflowV2ContextSelectionError(message, code, details);
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalClone(value, label = "value") {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    fail(`${label} 不是可确定性序列化的 JSON`, "WORKFLOW_V2_CONTEXT_NON_CANONICAL_INPUT", {
      causeCode: error?.code || "",
    });
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    fail(`${label} 必须是 JSON 对象`, "WORKFLOW_V2_CONTEXT_INVALID_INPUT", { field: label });
  }
  return value;
}

function normalizedKeyName(key) {
  return String(key).toLowerCase().replace(/[^a-z]/g, "");
}

function isRawHistoryKey(key) {
  const raw = String(key).toLowerCase();
  const normalized = normalizedKeyName(key);
  const aiDerivedAlias = (normalized.includes("assistant") || normalized.includes("model") || normalized.includes("ai"))
    && ["answer", "claim", "history", "output", "reply", "response", "result"]
      .some((part) => normalized.includes(part));
  const chineseAiAlias = (raw.includes("ai") || raw.includes("助手") || raw.includes("模型"))
    && ["之前", "上一", "历史", "回答", "回复", "结论", "输出", "旧"]
      .some((part) => raw.includes(part));
  return RAW_HISTORY_KEYS.has(normalized)
    || normalized.includes("assistanthistory")
    || normalized.includes("conversation")
    || normalized.endsWith("chatlog")
    || normalized.endsWith("chatmessages")
    || normalized === "turns"
    || aiDerivedAlias
    || chineseAiAlias;
}

function sanitizeUntrusted(value, droppedFields, fieldPath) {
  if (Array.isArray(value)) {
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      const selected = sanitizeUntrusted(value[index], droppedFields, `${fieldPath}[${index}]`);
      if (selected !== OMIT_UNTRUSTED_VALUE) output.push(selected);
    }
    return output;
  }
  if (!isPlainObject(value)) return value;
  if (typeof value.role === "string" && RAW_HISTORY_ROLES.has(value.role.toLowerCase())) {
    droppedFields.push(fieldPath);
    return OMIT_UNTRUSTED_VALUE;
  }
  const output = {};
  for (const key of Object.keys(value).sort(compareStrings)) {
    if (isRawHistoryKey(key)) {
      droppedFields.push(`${fieldPath}.${key}`);
      continue;
    }
    const selected = sanitizeUntrusted(value[key], droppedFields, `${fieldPath}.${key}`);
    if (selected !== OMIT_UNTRUSTED_VALUE) output[key] = selected;
  }
  return output;
}

function pickDefined(source, keys) {
  const output = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key) && source[key] !== undefined) output[key] = source[key];
  }
  return output;
}

function uniqueSortedStrings(values, field) {
  if (!Array.isArray(values)) fail(`${field} 必须是数组`, "WORKFLOW_V2_CONTEXT_INVALID_INPUT", { field });
  const selected = new Set();
  for (const value of values) {
    if (typeof value !== "string") fail(`${field} 只能包含字符串`, "WORKFLOW_V2_CONTEXT_INVALID_INPUT", { field });
    selected.add(value);
  }
  return [...selected].sort(compareStrings);
}

export function countUnicodeCharacters(value) {
  const text = typeof value === "string" ? value : canonicalJson(value);
  return Array.from(text).length;
}

function normalizeBudgetConfig(input) {
  const config = canonicalClone(input, "context budget config");
  if (config.schemaVersion !== "context-budget-v2" || config.units !== "unicodeCharacters") {
    fail("context budget config 版本或单位无效", "WORKFLOW_V2_CONTEXT_BUDGET_CONFIG_INVALID");
  }
  if (!Number.isSafeInteger(config.typicalTotalMax) || config.typicalTotalMax < 1
      || !Number.isSafeInteger(config.hardTotalMax) || config.hardTotalMax < config.typicalTotalMax) {
    fail("context budget 总量上限无效", "WORKFLOW_V2_CONTEXT_BUDGET_CONFIG_INVALID");
  }
  if (!isPlainObject(config.fields)) {
    fail("context budget fields 无效", "WORKFLOW_V2_CONTEXT_BUDGET_CONFIG_INVALID");
  }
  for (const field of REQUIRED_BUDGET_FIELDS) {
    if (!Number.isSafeInteger(config.fields[field]) || config.fields[field] < 1) {
      fail(`context budget 字段上限无效: ${field}`, "WORKFLOW_V2_CONTEXT_BUDGET_CONFIG_INVALID", { field });
    }
  }
  if (!isPlainObject(config.outputLimits)
      || !Number.isSafeInteger(config.outputLimits.shortReport)
      || config.outputLimits.shortReport < 1) {
    fail("context budget shortReport 输出上限无效", "WORKFLOW_V2_CONTEXT_BUDGET_CONFIG_INVALID");
  }
  return config;
}

export function loadContextBudgetConfig() {
  return canonicalClone(DEFAULT_BUDGET_CONFIG, "context budget config");
}

function assertWithinFieldBudget(field, value, maxCharacters) {
  if (value === undefined) return;
  const actualCharacters = countUnicodeCharacters(value);
  if (actualCharacters > maxCharacters) {
    fail(`${field} 超出字符预算`, "WORKFLOW_V2_CONTEXT_BUDGET_EXCEEDED", {
      field,
      actualCharacters,
      maxCharacters,
      protected: true,
    });
  }
}

function normalizeRoots(roots) {
  if (!Array.isArray(roots)) fail("scope.roots 必须是数组", "WORKFLOW_V2_CONTEXT_INVALID_INPUT");
  const byId = new Map();
  for (const source of roots) {
    assertPlainObject(source, "scope.roots[]");
    const root = pickDefined(source, ["rootId", "kind", "projectId", "branch", "flavor", "versionName", "writable"]);
    if (typeof root.rootId !== "string" || !root.rootId) {
      fail("scope root 缺少 rootId", "WORKFLOW_V2_CONTEXT_IDENTITY_CONFLICT");
    }
    const existing = byId.get(root.rootId);
    if (existing && canonicalJson(existing) !== canonicalJson(root)) {
      fail(`rootId 定义冲突: ${root.rootId}`, "WORKFLOW_V2_CONTEXT_IDENTITY_CONFLICT", { rootId: root.rootId });
    }
    if (!existing) byId.set(root.rootId, root);
  }
  return [...byId.values()].sort((left, right) => compareStrings(left.rootId, right.rootId));
}

function normalizeTrustedBase(baseContext) {
  const base = canonicalClone(assertPlainObject(baseContext, "baseContext"), "baseContext");
  assertPlainObject(base.story, "baseContext.story");
  assertPlainObject(base.stage, "baseContext.stage");
  assertPlainObject(base.task, "baseContext.task");
  assertPlainObject(base.scope, "baseContext.scope");
  assertPlainObject(base.capabilities, "baseContext.capabilities");
  assertPlainObject(base.output, "baseContext.output");

  const task = pickDefined(base.task, ["instruction", "successCriteria", "userVisibleGoal"]);
  task.successCriteria = uniqueSortedStrings(task.successCriteria, "task.successCriteria");
  const scope = pickDefined(base.scope, ["protectedPaths", "tempRootId", "deviceProfileId"]);
  scope.roots = normalizeRoots(base.scope.roots);
  if (scope.protectedPaths !== undefined) {
    scope.protectedPaths = uniqueSortedStrings(scope.protectedPaths, "scope.protectedPaths");
  }
  const capabilities = pickDefined(base.capabilities, [
    "allowedTools",
    "canWriteSource",
    "canReadGit",
    "canWriteGit",
    "canCommit",
    "canUseDevice",
    "canWriteTb",
    "canWriteReport",
    "maxToolIterations",
    "structuredOutput",
    "longProcessProtocol",
  ]);
  capabilities.allowedTools = uniqueSortedStrings(capabilities.allowedTools, "capabilities.allowedTools");

  return {
    schemaVersion: "tb-stage-context-v2",
    contextId: base.contextId,
    revision: base.revision,
    idempotencyKey: base.idempotencyKey,
    story: pickDefined(base.story, ["storyId", "ticketId", "carbId", "title", "groupId"]),
    stage: pickDefined(base.stage, ["id", "attempt", "riskLevel", "reportMode", "groupMode"]),
    task,
    scope,
    capabilities,
    output: pickDefined(base.output, ["schemaId", "maxChars", "outputPath"]),
  };
}

function reportScope(scope) {
  const source = scope.roots.find((entry) => entry.kind === "ARTIFACT") || scope.roots[0];
  const root = { rootId: source.rootId, kind: source.kind, writable: false };
  return { roots: [root] };
}

function reportCapabilities(capabilities, { expert = false } = {}) {
  const output = {
    allowedTools: [],
    canWriteSource: false,
    canReadGit: false,
    canWriteGit: false,
    canCommit: false,
    canUseDevice: false,
    canWriteTb: false,
    canWriteReport: expert && capabilities.canWriteReport === true,
    maxToolIterations: 0,
  };
  if (capabilities.structuredOutput !== undefined) output.structuredOutput = capabilities.structuredOutput;
  output.longProcessProtocol = "NONE";
  return output;
}

function normalizeReceiptIds(value, field) {
  return value === undefined ? undefined : uniqueSortedStrings(value, field);
}

function dedupeCheckpointEntries(entries, idSelector, normalize, label) {
  const selectId = typeof idSelector === "function" ? idSelector : (entry) => entry[idSelector];
  const byId = new Map();
  for (const source of entries) {
    const entry = normalize(source);
    const id = selectId(entry);
    if (typeof id !== "string" || !id) {
      fail(`${label} 缺少 stable ID`, "WORKFLOW_V2_CONTEXT_IDENTITY_CONFLICT", { field: label });
    }
    const existing = byId.get(id);
    if (existing && canonicalJson(existing) !== canonicalJson(entry)) {
      fail(`${label} stable ID 冲突: ${id}`, "WORKFLOW_V2_CONTEXT_IDENTITY_CONFLICT", { field: label, id });
    }
    if (!existing) byId.set(id, entry);
  }
  return [...byId.values()].sort((left, right) => compareStrings(selectId(left), selectId(right)));
}

function normalizeCheckpoint(checkpoint) {
  const selected = canonicalClone(checkpoint, "workflow checkpoint");
  try {
    workflowV2SchemaRegistry.assertValid(
      WORKFLOW_V2_SCHEMA_IDS.workflowCheckpoint,
      selected,
      "workflow checkpoint",
    );
  } catch (error) {
    fail("workflow checkpoint Schema 校验失败", "WORKFLOW_V2_CONTEXT_SOURCE_SCHEMA_INVALID", {
      source: "checkpoint",
      causeCode: error?.code || "",
      validationErrors: error?.validationErrors || [],
    });
  }
  selected.claims = dedupeCheckpointEntries(selected.claims, "claimId", (source) => ({
    ...source,
    evidenceIds: uniqueSortedStrings(source.evidenceIds, "checkpoint.claims[].evidenceIds"),
  }), "checkpoint.claims");
  selected.actions = dedupeCheckpointEntries(selected.actions, "actionId", (source) => ({
    ...source,
    ...(source.receiptIds === undefined ? {} : {
      receiptIds: normalizeReceiptIds(source.receiptIds, "checkpoint.actions[].receiptIds"),
    }),
  }), "checkpoint.actions");
  selected.changes = dedupeCheckpointEntries(selected.changes, (entry) => `${entry.rootId}\u0000${entry.path}`, (source) => ({
    ...source,
    ...(source.receiptIds === undefined ? {} : {
      receiptIds: normalizeReceiptIds(source.receiptIds, "checkpoint.changes[].receiptIds"),
    }),
  }), "checkpoint.changes");
  selected.verification = dedupeCheckpointEntries(selected.verification, "caseId", (source) => ({
    ...source,
    ...(source.receiptIds === undefined ? {} : {
      receiptIds: normalizeReceiptIds(source.receiptIds, "checkpoint.verification[].receiptIds"),
    }),
  }), "checkpoint.verification");
  selected.openItems = uniqueSortedStrings(selected.openItems, "checkpoint.openItems");
  const decisions = new Map();
  for (const decision of selected.userDecisions) decisions.set(canonicalJson(decision), decision);
  selected.userDecisions = [...decisions.values()].sort((left, right) => (
    compareStrings(left.at, right.at) || compareStrings(canonicalJson(left), canonicalJson(right))
  ));
  return selected;
}

function trimCheckpointToLimit(checkpoint, limit, drops) {
  while (countUnicodeCharacters(checkpoint) > limit) {
    if (checkpoint.summary !== undefined) {
      delete checkpoint.summary;
      drops.push({ field: "checkpoint", id: "summary", reason: "field_limit" });
      continue;
    }
    const unverifiedIndex = checkpoint.claims.findLastIndex((entry) => entry.status === "UNVERIFIED");
    if (unverifiedIndex >= 0) {
      const [removed] = checkpoint.claims.splice(unverifiedIndex, 1);
      drops.push({ field: "checkpoint", id: removed.claimId, reason: "field_limit_unverified" });
      continue;
    }
    const completedIndex = checkpoint.actions.findLastIndex((entry) => (
      entry.status === "COMPLETED" && !(entry.receiptIds?.length)
    ));
    if (completedIndex >= 0) {
      const [removed] = checkpoint.actions.splice(completedIndex, 1);
      drops.push({ field: "checkpoint", id: removed.actionId, reason: "field_limit_completed" });
      continue;
    }
    const optionalChangeIndex = checkpoint.changes.findLastIndex((entry) => !(entry.receiptIds?.length));
    if (optionalChangeIndex >= 0) {
      const [removed] = checkpoint.changes.splice(optionalChangeIndex, 1);
      drops.push({ field: "checkpoint", id: `${removed.rootId}:${removed.path}`, reason: "field_limit_change" });
      continue;
    }
    const optionalVerificationIndex = checkpoint.verification.findLastIndex((entry) => (
      entry.status === "NOT_RUN"
    ));
    if (optionalVerificationIndex >= 0) {
      const [removed] = checkpoint.verification.splice(optionalVerificationIndex, 1);
      drops.push({ field: "checkpoint", id: removed.caseId, reason: "field_limit_verification" });
      continue;
    }
    fail("checkpoint 受保护内容超出字符预算", "WORKFLOW_V2_CONTEXT_BUDGET_EXCEEDED", {
      field: "checkpoint",
      actualCharacters: countUnicodeCharacters(checkpoint),
      maxCharacters: limit,
      protected: true,
    });
  }
}

function commentTimestamp(comment) {
  return String(comment.updatedAt || comment.createdAt || "");
}

function normalizeComments(sources) {
  const comments = [
    ...(Array.isArray(sources.comments) ? sources.comments : []),
    ...(Array.isArray(sources.latestSubstantiveComments) ? sources.latestSubstantiveComments : []),
    ...(Array.isArray(sources.fullComments) ? sources.fullComments : []),
  ];
  const byId = new Map();
  for (const source of comments) {
    assertPlainObject(source, "sources.comments[]");
    const raw = pickDefined(source, [
      "commentId",
      "id",
      "_id",
      "text",
      "author",
      "createdAt",
      "updatedAt",
      "isCorrection",
      "verified",
    ]);
    const commentId = String(raw.commentId || raw.id || raw._id || `comment-${canonicalSha256({
      text: raw.text ?? "",
      author: raw.author ?? "",
      createdAt: raw.createdAt ?? "",
      updatedAt: raw.updatedAt ?? "",
    }).slice(0, 24)}`);
    const comment = pickDefined(raw, ["text", "author", "createdAt", "updatedAt", "isCorrection", "verified"]);
    comment.commentId = commentId;
    const existing = byId.get(commentId);
    if (!existing) {
      byId.set(commentId, comment);
      continue;
    }
    const candidates = [existing, comment].sort((left, right) => (
      compareStrings(commentTimestamp(right), commentTimestamp(left))
      || compareStrings(canonicalJson(left), canonicalJson(right))
    ));
    const merged = { ...candidates[0], commentId };
    if (existing.isCorrection === true || comment.isCorrection === true) merged.isCorrection = true;
    if (existing.verified === true || comment.verified === true) merged.verified = true;
    byId.set(commentId, merged);
  }
  return [...byId.values()].sort((left, right) => (
    compareStrings(commentTimestamp(right), commentTimestamp(left))
    || compareStrings(left.commentId, right.commentId)
  ));
}

function protectedCommentIds(comments) {
  const protectedIds = new Set();
  if (comments[0]) protectedIds.add(comments[0].commentId);
  const correction = comments.find((entry) => entry.isCorrection === true && entry.verified !== false);
  if (correction) protectedIds.add(correction.commentId);
  return protectedIds;
}

function dropOptionalComment(comments, protectedIds, drops, reason) {
  const index = comments.findLastIndex((entry) => !protectedIds.has(entry.commentId));
  if (index < 0) return false;
  const [removed] = comments.splice(index, 1);
  drops.push({ field: "data.latestSubstantiveComments", id: removed.commentId, reason });
  return true;
}

function trimCommentsToLimit(comments, limit, drops, protectedIds) {
  while (countUnicodeCharacters(comments) > limit) {
    if (!dropOptionalComment(comments, protectedIds, drops, "field_limit")) {
      fail("最新评论中的受保护纠偏超出字符预算", "WORKFLOW_V2_CONTEXT_BUDGET_EXCEEDED", {
        field: "data.latestSubstantiveComments",
        actualCharacters: countUnicodeCharacters(comments),
        maxCharacters: limit,
        protected: true,
      });
    }
  }
}

function evidenceIdentityField(existing, incoming, field, evidenceId) {
  const left = existing[field];
  const right = incoming[field];
  if (left === undefined || left === null) return right;
  if (right === undefined || right === null) return left;
  const normalizedLeft = field === "sha256" ? String(left).toLowerCase() : left;
  const normalizedRight = field === "sha256" ? String(right).toLowerCase() : right;
  if (canonicalJson(normalizedLeft) !== canonicalJson(normalizedRight)) {
    fail(`evidenceId 定义冲突: ${evidenceId}`, "WORKFLOW_V2_CONTEXT_IDENTITY_CONFLICT", {
      evidenceId,
      field,
    });
  }
  return normalizedLeft;
}

function normalizeEvidenceManifests(manifests, storyId, requiredEvidenceIds) {
  if (!manifests.length) return null;
  const byId = new Map();
  let coverage = "COMPLETE";
  const coverageReasons = new Set();
  for (const source of manifests) {
    const manifest = canonicalClone(source, "evidence manifest");
    try {
      workflowV2SchemaRegistry.assertValid(
        WORKFLOW_V2_SCHEMA_IDS.evidenceManifest,
        manifest,
        "evidence manifest",
      );
    } catch (error) {
      fail("evidence manifest Schema 校验失败", "WORKFLOW_V2_CONTEXT_SOURCE_SCHEMA_INVALID", {
        source: "evidenceManifest",
        causeCode: error?.code || "",
        validationErrors: error?.validationErrors || [],
      });
    }
    if (manifest.storyId !== storyId) {
      fail("evidence manifest storyId 与可信上下文不一致", "WORKFLOW_V2_CONTEXT_STORY_MISMATCH", {
        expectedStoryId: storyId,
        actualStoryId: manifest.storyId,
      });
    }
    if (COVERAGE_RANK[manifest.coverage] > COVERAGE_RANK[coverage]) coverage = manifest.coverage;
    if (manifest.coverageReason) coverageReasons.add(manifest.coverageReason);
    for (const sourceItem of manifest.items) {
      const item = canonicalClone(sourceItem, "evidence item");
      if (item.sha256) item.sha256 = item.sha256.toLowerCase();
      if (item.preprocessedRefs) item.preprocessedRefs = uniqueSortedStrings(item.preprocessedRefs, "evidence.preprocessedRefs");
      const existing = byId.get(item.evidenceId);
      if (!existing) {
        byId.set(item.evidenceId, item);
        continue;
      }
      const merged = { evidenceId: item.evidenceId };
      for (const field of ["type", "name", "contentRef", "sizeBytes", "sha256"]) {
        const value = evidenceIdentityField(existing, item, field, item.evidenceId);
        if (value !== undefined) merged[field] = value;
      }
      merged.availability = AVAILABILITY_RANK[existing.availability] >= AVAILABILITY_RANK[item.availability]
        ? existing.availability
        : item.availability;
      merged.required = existing.required === true || item.required === true;
      if (existing.relevance !== undefined || item.relevance !== undefined) {
        merged.relevance = Math.max(existing.relevance ?? 0, item.relevance ?? 0);
      }
      const refs = uniqueSortedStrings([
        ...(existing.preprocessedRefs || []),
        ...(item.preprocessedRefs || []),
      ], "evidence.preprocessedRefs");
      if (Object.hasOwn(existing, "preprocessedRefs") || Object.hasOwn(item, "preprocessedRefs")) {
        merged.preprocessedRefs = refs;
      }
      if (Object.hasOwn(existing, "instructionLikeContentDetected")
          || Object.hasOwn(item, "instructionLikeContentDetected")) {
        merged.instructionLikeContentDetected = existing.instructionLikeContentDetected === true
          || item.instructionLikeContentDetected === true;
      }
      byId.set(item.evidenceId, merged);
    }
  }
  for (const evidenceId of requiredEvidenceIds) {
    const item = byId.get(evidenceId);
    if (!item) {
      fail(`required evidence 不存在: ${evidenceId}`, "WORKFLOW_V2_CONTEXT_REQUIRED_EVIDENCE_MISSING", { evidenceId });
    }
    item.required = true;
  }
  const items = [...byId.values()].sort((left, right) => compareStrings(left.evidenceId, right.evidenceId));
  const result = {
    schemaVersion: "evidence-manifest-v2",
    storyId,
    coverage,
    items,
  };
  if (coverage !== "COMPLETE") {
    result.coverageReason = [...coverageReasons].sort(compareStrings).join(" | ") || "source coverage unavailable";
  } else if (coverageReasons.size) {
    result.coverageReason = [...coverageReasons].sort(compareStrings).join(" | ");
  }
  return result;
}

function evidenceOptionalOrder(manifest) {
  return manifest.items
    .map((item) => item)
    .sort((left, right) => (
      (left.relevance ?? 0) - (right.relevance ?? 0)
      || compareStrings(left.evidenceId, right.evidenceId)
    ));
}

function dropEvidenceMetadata(manifest, drops, reason) {
  for (const item of evidenceOptionalOrder(manifest).filter((entry) => entry.required !== true)) {
    const fields = EVIDENCE_METADATA_FIELDS.filter((field) => Object.hasOwn(item, field));
    if (fields.length) {
      for (const field of fields) delete item[field];
      drops.push({ field: "data.evidenceManifest", id: item.evidenceId, metadata: fields, reason });
      return true;
    }
  }
  return false;
}

function dropOptionalEvidenceItem(manifest, drops, reason) {
  const candidates = evidenceOptionalOrder(manifest).filter((item) => item.required !== true);
  if (!candidates.length) return false;
  const selected = candidates[0];
  manifest.items = manifest.items.filter((item) => item.evidenceId !== selected.evidenceId);
  if (manifest.coverage === "COMPLETE") manifest.coverage = "PARTIAL";
  const coverageReason = "context budget omitted optional evidence";
  const reasons = new Set(String(manifest.coverageReason || "").split(" | ").filter(Boolean));
  reasons.add(coverageReason);
  manifest.coverageReason = [...reasons].sort(compareStrings).join(" | ");
  drops.push({ field: "data.evidenceManifest", id: selected.evidenceId, reason });
  return true;
}

function trimEvidenceBucketToLimit(data, limit, drops) {
  while (countUnicodeCharacters(evidenceBudgetValue(data)) > limit) {
    const manifest = data.evidenceManifest;
    if (manifest && dropEvidenceMetadata(manifest, drops, "field_limit_metadata")) continue;
    if (manifest && dropOptionalEvidenceItem(manifest, drops, "field_limit_optional")) continue;
    fail("required evidence manifest 超出字符预算", "WORKFLOW_V2_CONTEXT_BUDGET_EXCEEDED", {
      field: "data.evidenceManifest",
      actualCharacters: countUnicodeCharacters(evidenceBudgetValue(data)),
      maxCharacters: limit,
      protected: true,
    });
  }
}

function normalizeMemory(memory) {
  if (!Array.isArray(memory)) fail("sources.memory 必须是数组", "WORKFLOW_V2_CONTEXT_INVALID_INPUT");
  const byId = new Map();
  for (const source of memory) {
    assertPlainObject(source, "sources.memory[]");
    const memoryId = String(source.memoryId || source.id || `memory-${canonicalSha256(source).slice(0, 24)}`);
    const item = pickDefined(source, ["text", "summary", "contentRef", "relevance"]);
    item.memoryId = memoryId;
    if (item.relevance === undefined) item.relevance = 0;
    if (typeof item.relevance !== "number" || !Number.isFinite(item.relevance)
        || item.relevance < 0 || item.relevance > 1) {
      fail(`memory relevance 无效: ${memoryId}`, "WORKFLOW_V2_CONTEXT_INVALID_INPUT", {
        field: "sources.memory[].relevance",
        memoryId,
      });
    }
    const existing = byId.get(memoryId);
    if (existing && canonicalJson(existing) !== canonicalJson(item)) {
      fail(`memory stable ID 冲突: ${memoryId}`, "WORKFLOW_V2_CONTEXT_IDENTITY_CONFLICT", { memoryId });
    }
    if (!existing) byId.set(memoryId, item);
  }
  return [...byId.values()].sort((left, right) => (
    (right.relevance ?? 0) - (left.relevance ?? 0)
    || compareStrings(left.memoryId, right.memoryId)
  ));
}

function dropLowRelevanceMemory(memory, drops, reason) {
  if (!memory.length) return false;
  const removed = memory.pop();
  drops.push({ field: "data.relevantMemory", id: removed.memoryId, reason });
  return true;
}

function trimMemoryToLimit(memory, limit, drops) {
  while (countUnicodeCharacters(memory) > limit && dropLowRelevanceMemory(memory, drops, "field_limit")) {}
}

function normalizeRelativePath(value) {
  if (typeof value !== "string" || !value || /[\0-\x1f\x7f]/.test(value)) {
    fail("相对路径无效", "WORKFLOW_V2_CONTEXT_PATH_INVALID", { path: value });
  }
  const slashPath = value.replaceAll("\\", "/");
  if (slashPath.startsWith("/") || slashPath.startsWith("//") || /^[a-zA-Z]:/.test(slashPath) || slashPath.includes(":")) {
    fail("只允许 rootId 下的相对路径", "WORKFLOW_V2_CONTEXT_PATH_INVALID", { path: value });
  }
  const segments = slashPath.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === ".." || /[. ]$/.test(segment))) {
    fail("相对路径包含不安全片段", "WORKFLOW_V2_CONTEXT_PATH_INVALID", { path: value });
  }
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (segments.some((segment) => reserved.test(segment))) {
    fail("相对路径包含 Windows 保留名称", "WORKFLOW_V2_CONTEXT_PATH_INVALID", { path: value });
  }
  return segments.join("/");
}

function normalizePaths(paths, rootIds) {
  if (!Array.isArray(paths)) fail("sources.paths 必须是数组", "WORKFLOW_V2_CONTEXT_INVALID_INPUT");
  const byKey = new Map();
  for (const source of paths) {
    assertPlainObject(source, "sources.paths[]");
    if (typeof source.rootId !== "string" || !rootIds.has(source.rootId)) {
      fail("路径引用了未知 rootId", "WORKFLOW_V2_CONTEXT_PATH_INVALID", { rootId: source.rootId });
    }
    const item = pickDefined(source, ["rootId", "summary", "sha256", "kind"]);
    item.path = normalizeRelativePath(source.path);
    if (item.sha256) item.sha256 = String(item.sha256).toLowerCase();
    const key = `${item.rootId}\u0000${item.path}`;
    const existing = byKey.get(key);
    if (existing && canonicalJson(existing) !== canonicalJson(item)) {
      fail(`路径元数据冲突: ${item.rootId}:${item.path}`, "WORKFLOW_V2_CONTEXT_IDENTITY_CONFLICT", {
        rootId: item.rootId,
        path: item.path,
      });
    }
    if (!existing) byKey.set(key, item);
  }
  return [...byKey.values()].sort((left, right) => (
    compareStrings(left.rootId, right.rootId) || compareStrings(left.path, right.path)
  ));
}

function collectManifestInputs(evidenceManifest, evidenceManifests, sources) {
  const selected = [];
  if (evidenceManifest !== undefined && evidenceManifest !== null) selected.push(evidenceManifest);
  if (evidenceManifests !== undefined) {
    if (!Array.isArray(evidenceManifests)) {
      fail("evidenceManifests 必须是数组", "WORKFLOW_V2_CONTEXT_INVALID_INPUT");
    }
    selected.push(...evidenceManifests);
  }
  if (sources.evidenceManifests !== undefined) {
    if (!Array.isArray(sources.evidenceManifests)) {
      fail("sources.evidenceManifests 必须是数组", "WORKFLOW_V2_CONTEXT_INVALID_INPUT");
    }
    selected.push(...sources.evidenceManifests);
  }
  return selected;
}

function normalizeStructuredPathReferences(value, rootIds, fieldPath) {
  if (Array.isArray(value)) {
    const normalized = value.map((entry, index) => (
      normalizeStructuredPathReferences(entry, rootIds, `${fieldPath}[${index}]`)
    ));
    if (normalized.length && normalized.every((entry) => isPlainObject(entry) && Object.hasOwn(entry, "path"))) {
      const byPath = new Map();
      for (const entry of normalized) {
        const key = `${entry.rootId}\u0000${entry.path}`;
        const existing = byPath.get(key);
        if (existing && canonicalJson(existing) !== canonicalJson(entry)) {
          fail(`结构化路径定义冲突: ${entry.rootId}:${entry.path}`, "WORKFLOW_V2_CONTEXT_IDENTITY_CONFLICT", {
            field: fieldPath,
            rootId: entry.rootId,
            path: entry.path,
          });
        }
        if (!existing) byPath.set(key, entry);
      }
      return [...byPath.values()].sort((left, right) => (
        compareStrings(left.rootId, right.rootId) || compareStrings(left.path, right.path)
      ));
    }
    return normalized;
  }
  if (!isPlainObject(value)) return value;
  const output = {};
  for (const key of Object.keys(value).sort(compareStrings)) {
    output[key] = normalizeStructuredPathReferences(value[key], rootIds, `${fieldPath}.${key}`);
  }
  if (Object.hasOwn(output, "path")) {
    if (typeof output.rootId !== "string" || !rootIds.has(output.rootId)) {
      fail("结构化 path 必须绑定可信 rootId", "WORKFLOW_V2_CONTEXT_PATH_INVALID", {
        field: fieldPath,
        rootId: output.rootId,
      });
    }
    output.path = normalizeRelativePath(output.path);
  }
  return output;
}

function sanitizeSourceField(source, droppedFields, field, rootIds) {
  const sanitized = sanitizeUntrusted(canonicalClone(source, `sources.${field}`), droppedFields, `sources.${field}`);
  if (sanitized === OMIT_UNTRUSTED_VALUE) return undefined;
  return rootIds ? normalizeStructuredPathReferences(sanitized, rootIds, `sources.${field}`) : sanitized;
}

function normalizeShortReportFacts(source, droppedFields) {
  const sanitized = sanitizeSourceField(source, droppedFields, "reportFacts");
  assertPlainObject(sanitized, "sources.reportFacts");
  const selected = pickDefined(sanitized, [
    "confidence",
    "cause",
    "causeUserFriendly",
    "measure",
    "measureUserFriendly",
    "remedy",
    "evidenceIds",
    "accepted",
    "testAcceptanceSkipped",
    "verificationStatus",
  ]);
  if (selected.evidenceIds !== undefined) {
    selected.evidenceIds = uniqueSortedStrings(selected.evidenceIds, "sources.reportFacts.evidenceIds");
  }
  const cause = selected.causeUserFriendly ?? selected.cause;
  const measure = selected.measureUserFriendly ?? selected.measure ?? selected.remedy;
  if (typeof cause !== "string" || !cause || typeof measure !== "string" || !measure) {
    fail("REPORT_SHORT reportFacts 必须包含原因与措施", "WORKFLOW_V2_CONTEXT_REQUIRED_DATA_MISSING", {
      field: "sources.reportFacts",
    });
  }
  return selected;
}

function buildStageData({
  stageId,
  sources,
  manifest,
  comments,
  memory,
  paths,
  requiredEvidence,
  droppedFields,
  reportMaxChars,
  reportOutputPath,
  rootIds,
  checkpointVerifiedEvidenceIds,
}) {
  const allowed = STAGE_DATA_FIELDS[stageId];
  if (!allowed) fail(`不支持的 stage: ${stageId}`, "WORKFLOW_V2_CONTEXT_STAGE_UNSUPPORTED", { stageId });
  const allowedSet = new Set(allowed);
  const candidates = {};
  if (allowedSet.has("issue") && sources.issue !== undefined) {
    candidates.issue = sanitizeSourceField(sources.issue, droppedFields, "issue", rootIds);
  }
  if (allowedSet.has("latestSubstantiveComments") && comments.length) {
    candidates.latestSubstantiveComments = comments;
  }
  if (allowedSet.has("evidenceManifest") && manifest) candidates.evidenceManifest = manifest;
  if (allowedSet.has("requiredEvidence") && requiredEvidence.length) candidates.requiredEvidence = requiredEvidence;
  if (allowedSet.has("relevantMemory") && memory.length) candidates.relevantMemory = memory;
  if (allowedSet.has("paths") && paths.length) candidates.paths = paths;

  for (const field of [
    "approvedPlan",
    "approvedPlanOrPriorResult",
    "priorStageResult",
    "triageResult",
    "repairResult",
    "currentDiff",
    "localChecks",
    "verificationPlan",
    "flavorProfile",
    "deviceProfile",
    "reportFacts",
    "assetManifest",
    "misc",
  ]) {
    if (allowedSet.has(field) && sources[field] !== undefined) {
      if (field === "approvedPlanOrPriorResult" && candidates.approvedPlan !== undefined) continue;
      candidates[field] = stageId === "REPORT_SHORT" && field === "reportFacts"
        ? normalizeShortReportFacts(sources[field], droppedFields)
        : sanitizeSourceField(sources[field], droppedFields, field, rootIds);
    }
  }
  if (stageId === "REPORT_EXPERT") {
    candidates.verifiedEvidenceIds = checkpointVerifiedEvidenceIds;
  }
  if (stageId === "REPORT_SHORT") {
    candidates.maxChars = reportMaxChars;
  }
  if (stageId === "REPORT_EXPERT") {
    candidates.outputPath = reportOutputPath;
  }

  const output = {};
  for (const field of allowed) {
    if (candidates[field] !== undefined) output[field] = candidates[field];
  }
  return output;
}

function approvedBudgetValue(data) {
  const selected = pickDefined(data, [
    "approvedPlan",
    "approvedPlanOrPriorResult",
    "priorStageResult",
    "triageResult",
    "repairResult",
    "reportFacts",
  ]);
  const keys = Object.keys(selected);
  if (!keys.length) return undefined;
  return keys.length === 1 ? selected[keys[0]] : selected;
}

function evidenceBudgetValue(data) {
  const selected = pickDefined(data, [
    "evidenceManifest",
    "requiredEvidence",
    "assetManifest",
    "verifiedEvidenceIds",
  ]);
  const keys = Object.keys(selected);
  if (!keys.length) return undefined;
  return keys.length === 1 ? selected[keys[0]] : selected;
}

function miscBudgetValue(data) {
  const selected = pickDefined(data, [
    "paths",
    "currentDiff",
    "localChecks",
    "verificationPlan",
    "flavorProfile",
    "deviceProfile",
    "misc",
    "maxChars",
    "outputPath",
  ]);
  const keys = Object.keys(selected);
  if (!keys.length) return undefined;
  return keys.length === 1 ? selected[keys[0]] : selected;
}

function enforceFieldBudgets(context, config, drops, protectedIds) {
  const fields = config.fields;
  assertWithinFieldBudget("task.instruction", context.task.instruction, fields["task.instruction"]);
  assertWithinFieldBudget("task.successCriteria", context.task.successCriteria, fields["task.successCriteria"]);
  assertWithinFieldBudget("data.issue", context.data.issue, fields["data.issue"]);
  assertWithinFieldBudget(
    "data.approvedPlanOrPriorResult",
    approvedBudgetValue(context.data),
    fields["data.approvedPlanOrPriorResult"],
  );
  assertWithinFieldBudget("data.misc", miscBudgetValue(context.data), fields["data.misc"]);

  if (context.data.relevantMemory) {
    trimMemoryToLimit(context.data.relevantMemory, fields["data.relevantMemory"], drops);
    if (!context.data.relevantMemory.length) delete context.data.relevantMemory;
  }
  if (evidenceBudgetValue(context.data) !== undefined) {
    trimEvidenceBucketToLimit(context.data, fields["data.evidenceManifest"], drops);
  }
  if (context.data.latestSubstantiveComments) {
    trimCommentsToLimit(
      context.data.latestSubstantiveComments,
      fields["data.latestSubstantiveComments"],
      drops,
      protectedIds,
    );
  }
  if (!Object.hasOwn(context.checkpoint, "ref")) {
    trimCheckpointToLimit(context.checkpoint, fields.checkpoint, drops);
  }
}

function trimOptionalToTypical(context, typicalMax, drops, protectedIds) {
  while (countUnicodeCharacters(context) > typicalMax) {
    if (context.data.relevantMemory?.length) {
      dropLowRelevanceMemory(context.data.relevantMemory, drops, "typical_total");
      if (!context.data.relevantMemory.length) delete context.data.relevantMemory;
      continue;
    }
    if (context.data.evidenceManifest && dropEvidenceMetadata(context.data.evidenceManifest, drops, "typical_total_metadata")) {
      continue;
    }
    if (context.data.evidenceManifest && dropOptionalEvidenceItem(context.data.evidenceManifest, drops, "typical_total_optional")) {
      continue;
    }
    if (context.data.latestSubstantiveComments
        && dropOptionalComment(context.data.latestSubstantiveComments, protectedIds, drops, "typical_total")) {
      continue;
    }
    break;
  }
}

function fieldCharacterReport(context) {
  const values = {
    "task.instruction": context.task.instruction,
    "task.successCriteria": context.task.successCriteria,
    "data.issue": context.data.issue,
    "data.latestSubstantiveComments": context.data.latestSubstantiveComments,
    checkpoint: context.checkpoint,
    "data.evidenceManifest": evidenceBudgetValue(context.data),
    "data.relevantMemory": context.data.relevantMemory,
    "data.approvedPlanOrPriorResult": approvedBudgetValue(context.data),
    "data.misc": miscBudgetValue(context.data),
  };
  return Object.fromEntries(Object.entries(values).map(([field, value]) => [
    field,
    value === undefined ? 0 : countUnicodeCharacters(value),
  ]));
}

function assertFinalContext(context) {
  try {
    if (context.data.evidenceManifest) {
      workflowV2SchemaRegistry.assertValid(
        WORKFLOW_V2_SCHEMA_IDS.evidenceManifest,
        context.data.evidenceManifest,
        "selected evidence manifest",
      );
    }
    workflowV2SchemaRegistry.assertValid(WORKFLOW_V2_SCHEMA_IDS.stageContext, context, "stage context");
  } catch (error) {
    fail("选择后的 stage context 不符合 Schema", "WORKFLOW_V2_CONTEXT_SCHEMA_INVALID", {
      causeCode: error?.code || "",
      validationErrors: error?.validationErrors || [],
    });
  }
}

export function selectStageContext({
  baseContext,
  checkpoint,
  evidenceManifest,
  evidenceManifests,
  sources = {},
  budgetConfig = DEFAULT_BUDGET_CONFIG,
} = {}) {
  const sourceSnapshot = canonicalClone(assertPlainObject(sources, "sources"), "sources");
  const context = normalizeTrustedBase(baseContext);
  const config = normalizeBudgetConfig(budgetConfig);
  const drops = [];
  const droppedFields = [];
  for (const key of Object.keys(sourceSnapshot).sort(compareStrings)) {
    if (CONTROL_KEYS.has(key)) droppedFields.push(`sources.${key}`);
  }

  const normalizedCheckpoint = normalizeCheckpoint(checkpoint);
  if (normalizedCheckpoint.storyId !== context.story.storyId) {
    fail("checkpoint storyId 与可信上下文不一致", "WORKFLOW_V2_CONTEXT_STORY_MISMATCH", {
      expectedStoryId: context.story.storyId,
      actualStoryId: normalizedCheckpoint.storyId,
    });
  }

  const stageId = context.stage.id;
  if (!STAGE_DATA_FIELDS[stageId]) {
    fail(`不支持的 stage: ${stageId}`, "WORKFLOW_V2_CONTEXT_STAGE_UNSUPPORTED", { stageId });
  }
  const reportStage = stageId === "REPORT_SHORT" || stageId === "REPORT_EXPERT";
  const allowedFields = new Set(STAGE_DATA_FIELDS[stageId]);
  const verifiedEvidenceIds = normalizedCheckpoint.claims
    .filter((claim) => claim.status === "VERIFIED")
    .flatMap((claim) => claim.evidenceIds);
  const sourceRequiredEvidence = allowedFields.has("requiredEvidence") && sourceSnapshot.requiredEvidence !== undefined
    ? uniqueSortedStrings(sourceSnapshot.requiredEvidence, "sources.requiredEvidence")
    : [];
  const requiredEvidenceForManifest = uniqueSortedStrings(
    [...sourceRequiredEvidence, ...verifiedEvidenceIds],
    "required evidence",
  );
  const manifests = allowedFields.has("evidenceManifest")
    ? collectManifestInputs(evidenceManifest, evidenceManifests, sourceSnapshot)
    : [];
  const manifest = normalizeEvidenceManifests(manifests, context.story.storyId, requiredEvidenceForManifest);
  if (allowedFields.has("evidenceManifest") && !manifest) {
    fail("该阶段必须提供 evidence manifest", "WORKFLOW_V2_CONTEXT_EVIDENCE_MANIFEST_REQUIRED", { stageId });
  }
  const requiredEvidence = manifest
    ? manifest.items.filter((item) => item.required === true).map((item) => item.evidenceId).sort(compareStrings)
    : [];
  const comments = allowedFields.has("latestSubstantiveComments") ? normalizeComments(sourceSnapshot) : [];
  const memory = allowedFields.has("relevantMemory")
    ? normalizeMemory(sourceSnapshot.memory || sourceSnapshot.relevantMemory || [])
    : [];
  const rootIds = new Set(context.scope.roots.map((entry) => entry.rootId));
  const paths = allowedFields.has("paths")
    ? normalizePaths(sourceSnapshot.paths || [], rootIds)
    : [];
  const protectedIds = protectedCommentIds(comments);
  const reportMaxChars = stageId === "REPORT_SHORT"
    ? (context.output.maxChars ?? config.outputLimits?.shortReport)
    : undefined;
  if (stageId === "REPORT_SHORT" && (!Number.isSafeInteger(reportMaxChars) || reportMaxChars < 1)) {
    fail("可信 REPORT_SHORT maxChars 无效", "WORKFLOW_V2_CONTEXT_INVALID_INPUT", {
      field: "baseContext.output.maxChars",
    });
  }
  if (stageId === "REPORT_SHORT" && reportMaxChars > config.outputLimits.shortReport) {
    fail("REPORT_SHORT maxChars 超出配置上限", "WORKFLOW_V2_CONTEXT_BUDGET_EXCEEDED", {
      field: "output.maxChars",
      actualCharacters: reportMaxChars,
      maxCharacters: config.outputLimits.shortReport,
      protected: true,
    });
  }
  const reportOutputPath = stageId === "REPORT_EXPERT" ? context.output.outputPath : undefined;
  if (stageId === "REPORT_EXPERT" && (typeof reportOutputPath !== "string" || !reportOutputPath)) {
    fail("REPORT_EXPERT 必须由可信控制面提供 outputPath", "WORKFLOW_V2_CONTEXT_REQUIRED_DATA_MISSING", {
      field: "baseContext.output.outputPath",
    });
  }

  context.data = buildStageData({
    stageId,
    sources: sourceSnapshot,
    manifest,
    comments,
    memory,
    paths,
    requiredEvidence,
    droppedFields,
    reportMaxChars,
    reportOutputPath,
    rootIds,
    checkpointVerifiedEvidenceIds: uniqueSortedStrings(verifiedEvidenceIds, "checkpoint VERIFIED evidence IDs"),
  });

  if (reportStage && context.data.reportFacts === undefined) {
    fail(`${stageId} 缺少 reportFacts`, "WORKFLOW_V2_CONTEXT_REQUIRED_DATA_MISSING", {
      field: "sources.reportFacts",
    });
  }
  if (stageId === "REPORT_EXPERT") {
    for (const field of ["assetManifest", "verifiedEvidenceIds", "outputPath"]) {
      if (context.data[field] === undefined) {
        fail(`REPORT_EXPERT 缺少 ${field}`, "WORKFLOW_V2_CONTEXT_REQUIRED_DATA_MISSING", { field: `data.${field}` });
      }
    }
  }

  if (reportStage) {
    context.scope = reportScope(context.scope);
    context.capabilities = reportCapabilities(context.capabilities, { expert: stageId === "REPORT_EXPERT" });
    context.checkpoint = {
      ref: `workflow-v2://checkpoint/${canonicalSha256(context.story.storyId)}/${normalizedCheckpoint.revision}/${canonicalSha256(normalizedCheckpoint)}`,
    };
    if (stageId === "REPORT_SHORT") {
      context.output.maxChars = context.data.maxChars;
      context.output.outputPath = null;
    }
  } else {
    context.checkpoint = normalizedCheckpoint;
  }

  enforceFieldBudgets(context, config, drops, protectedIds);
  trimOptionalToTypical(context, config.typicalTotalMax, drops, protectedIds);
  const totalCharacters = countUnicodeCharacters(context);
  if (totalCharacters > config.hardTotalMax) {
    fail("stage context 的受保护内容超出 hard total budget", "WORKFLOW_V2_CONTEXT_BUDGET_EXCEEDED", {
      field: "total",
      actualCharacters: totalCharacters,
      maxCharacters: config.hardTotalMax,
      protected: true,
      drops,
    });
  }

  assertFinalContext(context);
  const canonical = canonicalJson(context);
  const contextHash = canonicalSha256(context);
  return {
    context,
    canonical,
    contextHash,
    budget: {
      units: "unicodeCharacters",
      totalCharacters,
      typicalTotalMax: config.typicalTotalMax,
      hardTotalMax: config.hardTotalMax,
      typicalExceeded: totalCharacters > config.typicalTotalMax,
      fields: fieldCharacterReport(context),
      drops,
    },
    selection: {
      stageId,
      droppedFields: [...new Set(droppedFields)].sort(compareStrings),
    },
  };
}

function assertExactSourceEnvelope(envelope, {
  tab,
  payloadSchemaId,
  revision,
  label,
}) {
  const expectedStoryId = String(tab?.id ?? "");
  const valid = envelope?.payloadSchemaId === payloadSchemaId
    && envelope?.revision === revision
    && envelope?.storyId === expectedStoryId
    && envelope?.payload?.storyId === expectedStoryId
    && (payloadSchemaId !== WORKFLOW_V2_SCHEMA_IDS.workflowCheckpoint
      || envelope?.payload?.revision === revision);
  if (!valid) {
    fail(`${label} envelope 与请求 revision/identity 不一致`, "WORKFLOW_V2_CONTEXT_SOURCE_IDENTITY_MISMATCH", {
      label,
      expectedStoryId,
      actualStoryId: envelope?.storyId,
      expectedSchemaId: payloadSchemaId,
      actualSchemaId: envelope?.payloadSchemaId,
      expectedRevision: revision,
      actualRevision: envelope?.revision,
      payloadStoryId: envelope?.payload?.storyId,
      payloadRevision: envelope?.payload?.revision,
    });
  }
}

export async function selectStageContextFromStore({
  tab,
  baseContext,
  checkpointRevision,
  manifestRevision,
  sources = {},
  budgetConfig = DEFAULT_BUDGET_CONFIG,
  envelopeStore = workflowV2EnvelopeStore,
} = {}) {
  assertPlainObject(sources, "sources");
  for (const field of ["evidenceManifest", "evidenceManifests"]) {
    if (Object.hasOwn(sources, field)) {
      fail(`精确 revision 读取不允许 sources.${field} 覆盖`, "WORKFLOW_V2_CONTEXT_SOURCE_OVERRIDE_FORBIDDEN", {
        field: `sources.${field}`,
      });
    }
  }
  if (!Number.isSafeInteger(checkpointRevision) || checkpointRevision < 1
      || !Number.isSafeInteger(manifestRevision) || manifestRevision < 1) {
    fail("必须显式提供 checkpointRevision 与 manifestRevision", "WORKFLOW_V2_CONTEXT_SOURCE_REVISION_INVALID", {
      checkpointRevision,
      manifestRevision,
    });
  }
  const [checkpointEnvelope, manifestEnvelope] = await Promise.all([
    envelopeStore.readRevision({
      tab,
      payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.workflowCheckpoint,
      revision: checkpointRevision,
    }),
    envelopeStore.readRevision({
      tab,
      payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceManifest,
      revision: manifestRevision,
    }),
  ]);
  if (!checkpointEnvelope || !manifestEnvelope) {
    fail("指定 revision 的 checkpoint 或 manifest 不存在", "WORKFLOW_V2_CONTEXT_SOURCE_NOT_FOUND", {
      checkpointRevision,
      manifestRevision,
      checkpointFound: !!checkpointEnvelope,
      manifestFound: !!manifestEnvelope,
    });
  }
  assertExactSourceEnvelope(checkpointEnvelope, {
    tab,
    payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.workflowCheckpoint,
    revision: checkpointRevision,
    label: "checkpoint",
  });
  assertExactSourceEnvelope(manifestEnvelope, {
    tab,
    payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceManifest,
    revision: manifestRevision,
    label: "evidence manifest",
  });
  const result = selectStageContext({
    baseContext,
    checkpoint: checkpointEnvelope.payload,
    evidenceManifest: manifestEnvelope.payload,
    sources,
    budgetConfig,
  });
  return {
    ...result,
    sourceEnvelopes: {
      checkpoint: {
        revision: checkpointEnvelope.revision,
        envelopeSha256: checkpointEnvelope.envelopeSha256,
      },
      evidenceManifest: {
        revision: manifestEnvelope.revision,
        envelopeSha256: manifestEnvelope.envelopeSha256,
      },
    },
  };
}

export const workflowV2StageDataFields = STAGE_DATA_FIELDS;
