const SERVING_STATUSES = new Set(["approved", "active", "verified"]);
const ACCEPTED_EXECUTION_OUTCOMES = new Set(["accepted", "verified", "success"]);
const APPLICATION_FIELDS = ["appName", "application", "app"];
const REPOSITORY_FIELDS = ["repositoryId", "repoId", "repository"];
const CASE_MEMORY_SOURCE_REFS = new WeakMap();

function text(value, limit = 20_000) {
  return String(value ?? "").trim().slice(0, limit);
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function unique(values = []) {
  return [...new Set(values.map((value) => text(value).toLowerCase()).filter(Boolean))];
}

function clonePortable(value) {
  if (Array.isArray(value)) return value.map(clonePortable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clonePortable(child)]));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function first(source, fields) {
  for (const field of fields) {
    const value = text(source?.[field]);
    if (value) return value;
  }
  return "";
}

export function tokenizeConfigInferenceText(value) {
  const normalized = text(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{Letter}\p{Number}._:/+-]+/gu, " ")
    .trim();
  const tokens = [];
  for (const segment of normalized.split(/\s+/).filter(Boolean)) {
    tokens.push(segment);
    const compact = segment.replace(/[._:/+-]+/g, "");
    if (/[\p{Script=Han}]/u.test(compact)) {
      const chars = [...compact];
      for (let size = 2; size <= 3; size += 1) {
        for (let index = 0; index <= chars.length - size; index += 1) {
          tokens.push(chars.slice(index, index + size).join(""));
        }
      }
    } else {
      const parts = segment.split(/[._:/+-]+/).filter(Boolean);
      tokens.push(...parts);
    }
  }
  return unique(tokens);
}

function memoryTarget(memory = {}) {
  const target = memory?.target
    || memory?.groundTruth?.targets?.[0]
    || memory?.approvedLabel?.targets?.[0]
    || memory?.prediction?.targets?.[0]
    || {};
  return {
    projectId: text(memory?.projectId || target?.projectId),
    vehicle: text(target?.vehicle || memory?.vehicle),
    application: first(target, APPLICATION_FIELDS) || first(memory, APPLICATION_FIELDS),
    repositoryId: first(target, REPOSITORY_FIELDS) || first(memory, REPOSITORY_FIELDS),
  };
}

function queryContext(query = {}) {
  const target = query?.context || query || {};
  return {
    projectId: text(target?.projectId || query?.projectId),
    vehicle: text(target?.vehicle || query?.vehicle),
    application: first(target, APPLICATION_FIELDS) || first(query, APPLICATION_FIELDS),
    repositoryId: first(target, REPOSITORY_FIELDS) || first(query, REPOSITORY_FIELDS),
  };
}

/**
 * Structured inference and generic RAG must use this same predicate.
 * Application-specific positive memories cannot add score while current application/repository is
 * unresolved; callers may still show them in a clearly separated explanation-only section.
 */
export function evaluateCaseMemoryCompatibility(memory = {}, query = {}) {
  const stored = memoryTarget(memory);
  const current = queryContext(query);
  const blockers = [];
  const warnings = [];

  if (stored.projectId && current.projectId && stored.projectId !== current.projectId) {
    blockers.push("PROJECT_MISMATCH");
  }
  if (stored.vehicle && current.vehicle && stored.vehicle.toLowerCase() !== current.vehicle.toLowerCase()) {
    blockers.push("VEHICLE_MISMATCH");
  }
  if (current.repositoryId) {
    if (stored.repositoryId && stored.repositoryId !== current.repositoryId) {
      blockers.push("REPOSITORY_MISMATCH");
    }
  } else if (current.application) {
    if (stored.application && stored.application.toLowerCase() !== current.application.toLowerCase()) {
      blockers.push("APPLICATION_MISMATCH");
    }
  } else if (stored.application || stored.repositoryId) {
    warnings.push("APPLICATION_CONTEXT_REQUIRED");
  }

  return {
    compatible: blockers.length === 0 && warnings.length === 0,
    explanationOnly: blockers.length === 0 && warnings.length > 0,
    blockers,
    warnings,
    memoryContext: stored,
    queryContext: current,
  };
}

function servingStatus(memory = {}) {
  return text(
    memory?.serving?.status
    || memory?.servingStatus
    || memory?.approvedLabel?.status
    || memory?.status,
  ).toLowerCase();
}

function eligibleServingMemory(memory = {}, inferenceAt) {
  if (!SERVING_STATUSES.has(servingStatus(memory))) {
    return { eligible: false, reason: "NOT_APPROVED" };
  }
  if (text(memory?.recordType || memory?.source).toLowerCase() === "actual_execution") {
    const outcome = text(memory?.outcome || memory?.actualExecution?.outcome).toLowerCase();
    if (!ACCEPTED_EXECUTION_OUTCOMES.has(outcome)) {
      return { eligible: false, reason: "EXECUTION_NOT_ACCEPTED" };
    }
  }
  const evidenceAvailable = timestamp(memory?.availableAt || memory?.createdAt);
  const approvalAvailable = timestamp(
    memory?.serving?.activatedAt
    || memory?.serving?.approvedAt
    || memory?.approvedAt,
  );
  const effectiveAvailable = Math.max(
    evidenceAvailable || 0,
    approvalAvailable || evidenceAvailable || 0,
  ) || null;
  const cutoff = timestamp(inferenceAt);
  if (!effectiveAvailable) {
    return { eligible: false, reason: "MEMORY_TIME_MISSING" };
  }
  if (cutoff && effectiveAvailable > cutoff) {
    return { eligible: false, reason: "FUTURE_MEMORY" };
  }
  if (memory?.supersededBy || memory?.revokedAt || memory?.deletedAt) {
    return { eligible: false, reason: "REVOKED_OR_SUPERSEDED" };
  }
  return { eligible: true, reason: "" };
}

function memoryText(memory = {}) {
  const ticket = memory?.sourceSnapshot?.ticket || memory?.ticket || {};
  const comments = Array.isArray(ticket?.comments)
    ? ticket.comments.map((row) => row?.text || row).join(" ")
    : "";
  const attachments = Array.isArray(ticket?.attachments)
    ? ticket.attachments.map((row) => row?.textSummary || row?.name).join(" ")
    : "";
  const evidence = Array.isArray(memory?.evidence)
    ? memory.evidence.map((row) => row?.value || row?.span || row?.text).join(" ")
    : "";
  const target = memoryTarget(memory);
  return [
    ticket?.title,
    ticket?.description,
    ticket?.note,
    comments,
    attachments,
    evidence,
    target.projectId,
    target.vehicle,
    target.application,
    target.repositoryId,
  ].map(text).filter(Boolean).join(" ");
}

export function buildApprovedCaseRetrievalIndex(memories = [], {
  inferenceAt = new Date().toISOString(),
  k1 = 1.2,
  b = 0.75,
} = {}) {
  const excluded = [];
  const documents = [];
  for (const [index, memory] of (Array.isArray(memories) ? memories : []).entries()) {
    const gate = eligibleServingMemory(memory, inferenceAt);
    const id = text(memory?.id || memory?.sampleId || memory?.caseId) || `memory_${index + 1}`;
    if (!gate.eligible) {
      excluded.push({ id, reason: gate.reason });
      continue;
    }
    const memorySnapshot = deepFreeze(clonePortable(memory));
    const tokens = tokenizeConfigInferenceText(memoryText(memorySnapshot));
    const frequency = {};
    tokens.forEach((token) => {
      frequency[token] = (frequency[token] || 0) + 1;
    });
    const document = {
      id,
      memory: memorySnapshot,
      tokens,
      frequency,
      length: tokens.length,
    };
    CASE_MEMORY_SOURCE_REFS.set(document, memory);
    documents.push(deepFreeze(document));
  }
  const documentFrequency = {};
  documents.forEach((document) => {
    new Set(document.tokens).forEach((token) => {
      documentFrequency[token] = (documentFrequency[token] || 0) + 1;
    });
  });
  const averageLength = documents.length
    ? documents.reduce((sum, row) => sum + row.length, 0) / documents.length
    : 1;
  return deepFreeze({
    schemaVersion: "approved-case-index/v1",
    inferenceAt: new Date(inferenceAt).toISOString(),
    documents,
    documentFrequency,
    averageLength,
    k1: Math.max(0.01, finite(k1, 1.2)),
    b: Math.max(0, Math.min(1, finite(b, 0.75))),
    excluded,
  });
}

function bm25Score(index, document, queryTokens) {
  const total = index.documents.length;
  if (!total || !document.length) return 0;
  return queryTokens.reduce((score, token) => {
    const termFrequency = document.frequency[token] || 0;
    if (!termFrequency) return score;
    const documentFrequency = index.documentFrequency[token] || 0;
    const idf = Math.log(1 + (total - documentFrequency + 0.5) / (documentFrequency + 0.5));
    const denominator = termFrequency + index.k1 * (
      1 - index.b + index.b * document.length / Math.max(1, index.averageLength)
    );
    return score + idf * (termFrequency * (index.k1 + 1)) / denominator;
  }, 0);
}

/**
 * Retrieve only approved and time-valid memories. Optional embedding scores can rerank legal
 * documents, but cannot reintroduce filtered or context-incompatible memories.
 */
export async function retrieveApprovedConfigInferenceCases(index, query = {}, {
  limit = 10,
  embeddingSimilarity,
  sparseWeight = 0.7,
  denseWeight = 0.3,
  includeExplanationOnly = false,
} = {}) {
  if (index?.schemaVersion !== "approved-case-index/v1") {
    throw new Error("案例检索索引无效");
  }
  const queryText = [
    query?.title,
    query?.description,
    query?.note,
    ...(Array.isArray(query?.comments) ? query.comments.map((row) => row?.text || row) : []),
    queryContext(query).vehicle,
    queryContext(query).application,
    queryContext(query).repositoryId,
  ].map(text).filter(Boolean).join(" ");
  const tokens = tokenizeConfigInferenceText(queryText);
  const rows = [];
  for (const document of index.documents) {
    const currentMemory = CASE_MEMORY_SOURCE_REFS.get(document) || document.memory;
    if (!eligibleServingMemory(currentMemory, index.inferenceAt).eligible) continue;
    const compatibility = evaluateCaseMemoryCompatibility(document.memory, query);
    if (!compatibility.compatible && !(includeExplanationOnly && compatibility.explanationOnly)) {
      continue;
    }
    const sparseScore = bm25Score(index, document, tokens);
    const denseScore = typeof embeddingSimilarity === "function"
      ? Math.max(0, Math.min(1, finite(await embeddingSimilarity(queryText, memoryText(document.memory)))))
      : 0;
    const eligibleForScoring = compatibility.compatible;
    const score = eligibleForScoring
      ? Math.max(0, finite(sparseWeight, 0.7)) * sparseScore
        + Math.max(0, finite(denseWeight, 0.3)) * denseScore
      : 0;
    rows.push({
      id: document.id,
      memory: document.memory,
      eligibleForScoring,
      explanationOnly: compatibility.explanationOnly,
      compatibility,
      sparseScore,
      denseScore,
      score,
    });
  }
  return rows
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, Math.max(0, Math.trunc(finite(limit, 10))));
}
