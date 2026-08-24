import { createHash, randomUUID } from "crypto";

export const CONVERSATION_SCHEMA_VERSION = 2;
const INTERNAL_PROVENANCE_OWNER = "devbench-conversation-v2";

function cloneJson(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function stableLegacyId(tabId, message, index) {
  const source = JSON.stringify([
    String(tabId || ""),
    index,
    message?.role || "",
    message?.turn || "",
    message?.ts || message?.created_at || message?.createdAt || "",
    message?.content || "",
  ]);
  return `legacy-${createHash("sha256").update(source, "utf8").digest("hex").slice(0, 24)}`;
}

function nodeRank(node, index) {
  return [
    Number(node?.sequence) || 0,
    Number(node?.ts || node?.created_at || node?.createdAt) || 0,
    index,
  ];
}

function compareRank(left, right) {
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

export function normalizeConversation(raw, { tabId = "" } = {}) {
  const sourceNodes = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.nodes) ? raw.nodes : []);
  const used = new Set();
  const ids = sourceNodes.map((message, index) => {
    let id = String(message?.id || "").trim() || stableLegacyId(tabId, message, index);
    if (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    return id;
  });
  const idSet = new Set(ids);
  const hasInternalProvenance = !Array.isArray(raw)
    && raw?.internal?.owner === INTERNAL_PROVENANCE_OWNER;
  const priorGeneratedFields = hasInternalProvenance
    && raw.internal.generatedFieldsByNodeId
    && typeof raw.internal.generatedFieldsByNodeId === "object"
    ? raw.internal.generatedFieldsByNodeId
    : {};
  const priorOriginalFieldValues = hasInternalProvenance
    && raw.internal.originalFieldValuesByNodeId
    && typeof raw.internal.originalFieldValuesByNodeId === "object"
    ? raw.internal.originalFieldValuesByNodeId
    : {};
  const generatedFieldsByNodeId = {};
  const originalFieldValuesByNodeId = {};
  const nodes = sourceNodes.map((message, index) => {
    const source = cloneJson(message, {}) || {};
    const generatedFields = new Set(Array.isArray(priorGeneratedFields[ids[index]])
      ? priorGeneratedFields[ids[index]].map(String)
      : []);
    const originalFieldValues = cloneJson(priorOriginalFieldValues[ids[index]], {}) || {};
    if (!hasInternalProvenance) {
      for (const field of ["id", "parentId", "sequence", "revisionRootId", "revisionNo", "revisionOfId", "editedFromId"]) {
        if (Object.prototype.hasOwnProperty.call(source, field)) originalFieldValues[field] = cloneJson(source[field], source[field]);
      }
    }
    if (!Object.prototype.hasOwnProperty.call(source, "id")) generatedFields.add("id");
    const hasExplicitParent = Object.prototype.hasOwnProperty.call(source, "parentId");
    if (!hasExplicitParent) generatedFields.add("parentId");
    const explicitParentId = source.parentId == null ? "" : String(source.parentId).trim();
    const parentId = hasExplicitParent
      ? (explicitParentId && idSet.has(explicitParentId) ? explicitParentId : null)
      : (index > 0 ? ids[index - 1] : null);
    const node = {
      ...source,
      id: ids[index],
      parentId,
      sequence: Number(source.sequence) || index + 1,
    };
    if (!Object.prototype.hasOwnProperty.call(source, "sequence")) generatedFields.add("sequence");
    if (node.role === "user") {
      node.revisionRootId = String(source.revisionRootId || source.revisionOfId || node.id);
      node.revisionNo = Math.max(1, Number(source.revisionNo) || 1);
      if (!Object.prototype.hasOwnProperty.call(source, "revisionRootId")) generatedFields.add("revisionRootId");
      if (!Object.prototype.hasOwnProperty.call(source, "revisionNo")) generatedFields.add("revisionNo");
    }
    generatedFieldsByNodeId[node.id] = [...generatedFields];
    if (Object.keys(originalFieldValues).length) originalFieldValuesByNodeId[node.id] = originalFieldValues;
    return node;
  });
  const requestedHeadId = Array.isArray(raw) ? "" : String(raw?.headId || raw?.currentNodeId || "").trim();
  const headId = idSet.has(requestedHeadId) ? requestedHeadId : (nodes.at(-1)?.id || null);
  return {
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    revision: Math.max(0, Number(Array.isArray(raw) ? 0 : raw?.revision) || 0),
    headId,
    nextSequence: Math.max(
      1,
      Number(Array.isArray(raw) ? 0 : raw?.nextSequence) || 0,
      nodes.reduce((max, node) => Math.max(max, Number(node.sequence) || 0), 0) + 1,
    ),
    nodes,
    internal: {
      owner: INTERNAL_PROVENANCE_OWNER,
      generatedFieldsByNodeId,
      originalFieldValuesByNodeId,
    },
  };
}

export function activeConversationPath(conversation) {
  const graph = normalizeConversation(conversation);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const path = [];
  const seen = new Set();
  let current = byId.get(graph.headId) || null;
  while (current && !seen.has(current.id)) {
    path.push(current);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) || null : null;
  }
  return path.reverse().map((node) => cloneJson(node, {}));
}

export function conversationView(conversation) {
  const graph = normalizeConversation(conversation);
  const activePath = activeConversationPath(graph);
  const { internal: _internal, ...publicGraph } = graph;
  return {
    ...publicGraph,
    currentNodeId: graph.headId,
    activePathIds: activePath.map((node) => node.id),
  };
}

export function legacyMessageProjection(node, generatedFields = [], originalFieldValues = {}) {
  const projected = cloneJson(node, {}) || {};
  for (const field of generatedFields || []) delete projected[field];
  for (const [field, value] of Object.entries(originalFieldValues || {})) {
    projected[field] = cloneJson(value, value);
  }
  return projected;
}

export function legacyConversationMessages(conversation) {
  const graph = normalizeConversation(conversation);
  const generated = graph.internal?.generatedFieldsByNodeId || {};
  const originals = graph.internal?.originalFieldValuesByNodeId || {};
  return activeConversationPath(graph).map((node) => legacyMessageProjection(node, generated[node.id], originals[node.id]));
}

export function appendConversationNode(conversation, message, {
  parentId,
  makeHead = true,
  expectedRevision,
} = {}) {
  const graph = normalizeConversation(conversation);
  if (expectedRevision != null && Number(expectedRevision) !== graph.revision) {
    const error = new Error(`对话版本已变化：期望 ${expectedRevision}，实际 ${graph.revision}`);
    error.code = "CONVERSATION_REVISION_CONFLICT";
    error.statusCode = 409;
    throw error;
  }
  const resolvedParentId = parentId === undefined ? graph.headId : (parentId || null);
  if (resolvedParentId && !graph.nodes.some((node) => node.id === resolvedParentId)) {
    const error = new Error("父消息不存在或不属于当前故事点");
    error.code = "CONVERSATION_PARENT_NOT_FOUND";
    error.statusCode = 409;
    throw error;
  }
  let id = String(message?.id || "").trim() || randomUUID();
  if (graph.nodes.some((node) => node.id === id)) {
    const existing = graph.nodes.find((node) => node.id === id);
    return { conversation: graph, node: cloneJson(existing, {}), duplicate: true };
  }
  const node = {
    ...cloneJson(message, {}),
    id,
    parentId: resolvedParentId,
    sequence: graph.nextSequence,
    ts: Number(message?.ts) || Date.now(),
  };
  if (node.role === "user") {
    node.revisionRootId = String(node.revisionRootId || node.revisionOfId || node.id);
    node.revisionNo = Math.max(1, Number(node.revisionNo) || 1);
  }
  const generatedFields = ["id", "parentId", "sequence"];
  if (node.role === "user") {
    generatedFields.push("revisionRootId", "revisionNo");
    if (node.revisionOfId) generatedFields.push("revisionOfId");
    if (node.editedFromId) generatedFields.push("editedFromId");
  }
  const next = {
    ...graph,
    revision: graph.revision + 1,
    headId: makeHead ? node.id : graph.headId,
    nextSequence: graph.nextSequence + 1,
    nodes: [...graph.nodes, node],
    internal: {
      owner: INTERNAL_PROVENANCE_OWNER,
      generatedFieldsByNodeId: {
        ...(graph.internal?.generatedFieldsByNodeId || {}),
        [node.id]: generatedFields,
      },
      originalFieldValuesByNodeId: {
        ...(graph.internal?.originalFieldValuesByNodeId || {}),
      },
    },
  };
  return { conversation: next, node: cloneJson(node, {}), duplicate: false };
}

export function createUserRevision(conversation, {
  messageId,
  content,
  id,
  expectedRevision,
  metadata = {},
} = {}) {
  const graph = normalizeConversation(conversation);
  if (expectedRevision != null && Number(expectedRevision) !== graph.revision) {
    const error = new Error(`对话版本已变化：期望 ${expectedRevision}，实际 ${graph.revision}`);
    error.code = "CONVERSATION_REVISION_CONFLICT";
    error.statusCode = 409;
    throw error;
  }
  const source = graph.nodes.find((node) => node.id === String(messageId || ""));
  if (!source) {
    const error = new Error("要编辑的消息不存在或不属于当前故事点");
    error.code = "CONVERSATION_MESSAGE_NOT_FOUND";
    error.statusCode = 404;
    throw error;
  }
  if (source.role !== "user") {
    const error = new Error("只能编辑用户发送的消息");
    error.code = "CONVERSATION_MESSAGE_NOT_EDITABLE";
    error.statusCode = 400;
    throw error;
  }
  const revisionRootId = String(source.revisionRootId || source.id);
  const revisionNo = graph.nodes
    .filter((node) => node.role === "user"
      && node.parentId === source.parentId
      && String(node.revisionRootId || node.id) === revisionRootId)
    .reduce((max, node) => Math.max(max, Number(node.revisionNo) || 1), 0) + 1;
  return appendConversationNode(graph, {
    ...cloneJson(metadata, {}),
    id: String(id || "").trim() || randomUUID(),
    role: "user",
    content: String(content || ""),
    revisionRootId,
    revisionOfId: source.id,
    editedFromId: source.id,
    revisionNo,
  }, {
    parentId: source.parentId,
    expectedRevision: graph.revision,
  });
}

export function resolveLatestLeaf(conversation, messageId) {
  const graph = normalizeConversation(conversation);
  const start = graph.nodes.find((node) => node.id === String(messageId || ""));
  if (!start) {
    const error = new Error("要选择的消息不存在或不属于当前故事点");
    error.code = "CONVERSATION_MESSAGE_NOT_FOUND";
    error.statusCode = 404;
    throw error;
  }
  const indexes = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const children = new Map();
  for (const node of graph.nodes) {
    if (!node.parentId) continue;
    const list = children.get(node.parentId) || [];
    list.push(node);
    children.set(node.parentId, list);
  }
  let leaf = start;
  const seen = new Set();
  while (!seen.has(leaf.id)) {
    seen.add(leaf.id);
    const candidates = children.get(leaf.id) || [];
    if (!candidates.length) break;
    leaf = candidates.reduce((latest, candidate) => (
      compareRank(nodeRank(candidate, indexes.get(candidate.id)), nodeRank(latest, indexes.get(latest.id))) > 0
        ? candidate
        : latest
    ));
  }
  return cloneJson(leaf, {});
}

export function updateConversationNodeFields(conversation, nodeId, fields = {}) {
  const graph = normalizeConversation(conversation);
  const patch = cloneJson(fields, {});
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    const node = graph.nodes.find((item) => item.id === String(nodeId || ""));
    return { conversation: graph, node: node ? cloneJson(node, {}) : null, changed: false };
  }
  const index = graph.nodes.findIndex((item) => item.id === String(nodeId || ""));
  if (index === -1) {
    const error = new Error("要更新的消息不存在或不属于当前故事点");
    error.code = "CONVERSATION_MESSAGE_NOT_FOUND";
    error.statusCode = 404;
    throw error;
  }
  const current = graph.nodes[index];
  const node = { ...current, ...patch };
  const nodes = [...graph.nodes];
  nodes[index] = node;
  return {
    conversation: { ...graph, revision: graph.revision + 1, nodes },
    node: cloneJson(node, {}),
    changed: true,
  };
}

export function selectConversationNode(conversation, messageId, { expectedRevision } = {}) {
  const graph = normalizeConversation(conversation);
  if (expectedRevision != null && Number(expectedRevision) !== graph.revision) {
    const error = new Error(`对话版本已变化：期望 ${expectedRevision}，实际 ${graph.revision}`);
    error.code = "CONVERSATION_REVISION_CONFLICT";
    error.statusCode = 409;
    throw error;
  }
  const leaf = resolveLatestLeaf(graph, messageId);
  if (leaf.id === graph.headId) return { conversation: graph, head: leaf, changed: false };
  return {
    conversation: { ...graph, revision: graph.revision + 1, headId: leaf.id },
    head: leaf,
    changed: true,
  };
}
