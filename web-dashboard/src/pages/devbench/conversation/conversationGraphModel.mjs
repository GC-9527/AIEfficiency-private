function nodeList(conversation) {
  const nodes = conversation?.nodes;
  if (Array.isArray(nodes)) return nodes.filter(Boolean);
  if (nodes && typeof nodes === "object") return Object.entries(nodes).map(([id, node]) => ({ id, ...(node || {}) }));
  return [];
}

function explicitMessageId(message) {
  return message?.id || message?.messageId || message?.nodeId || message?._id;
}

export function messageStableId(message, fallbackIndex = 0) {
  const explicit = explicitMessageId(message);
  if (explicit) return String(explicit);
  const role = String(message?.role || "message");
  const turn = message?.turn ?? message?.turnId ?? "legacy";
  const created = message?.createdAt || message?.created_at || message?.ts || fallbackIndex;
  return `legacy:${role}:${turn}:${created}:${fallbackIndex}`;
}

export function conversationMessageStableId(conversation, message, fallbackIndex = 0) {
  const explicit = explicitMessageId(message);
  if (explicit) return String(explicit);
  const fallback = messageStableId(message, fallbackIndex);

  const candidateId = conversation?.activePathIds?.[fallbackIndex];
  if (!candidateId) return fallback;
  const candidate = nodeList(conversation).find((node, index) => nodeId(node, index) === String(candidateId));
  if (!candidate) return fallback;

  const messageRole = String(message?.role || "");
  const candidateRole = String(candidate?.role || "");
  if (messageRole && candidateRole && messageRole !== candidateRole) return fallback;
  if (
    Object.prototype.hasOwnProperty.call(message || {}, "content")
    && Object.prototype.hasOwnProperty.call(candidate || {}, "content")
    && String(message?.content ?? "") !== String(candidate?.content ?? "")
  ) return fallback;

  return String(candidateId);
}

function nodeId(node, fallbackIndex = 0) {
  return messageStableId(node, fallbackIndex);
}

function parentId(node) {
  const value = node?.parentId ?? node?.parent_id ?? null;
  return value == null || value === "" ? null : String(value);
}

function revisionGroupId(node) {
  const value = node?.revisionGroupId ?? node?.revision_group_id ?? node?.branchGroupId ?? node?.branch_group_id;
  return value == null || value === "" ? null : String(value);
}

function revisionOfId(node) {
  const value = node?.revisionOfId ?? node?.revision_of_id ?? null;
  return value == null || value === "" ? null : String(value);
}

function createdAtValue(node, fallbackIndex) {
  const value = node?.createdAt || node?.created_at || node?.ts;
  const parsed = value == null ? NaN : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : fallbackIndex;
}

function revisionRootId(node, byId) {
  let current = node;
  const seen = new Set();
  while (current) {
    const currentId = nodeId(current);
    if (seen.has(currentId)) break;
    seen.add(currentId);
    const previousId = revisionOfId(current);
    if (!previousId || !byId.has(previousId)) return currentId;
    current = byId.get(previousId);
  }
  return nodeId(node);
}

export function conversationRevision(conversation) {
  const revision = Number(conversation?.revision);
  return Number.isFinite(revision) ? revision : 0;
}

export function messageRevisionNavigation(conversation, message, fallbackIndex = 0) {
  const currentId = messageStableId(message, fallbackIndex);
  const nodes = nodeList(conversation);
  const indexed = nodes.map((node, index) => ({ node, index, id: nodeId(node, index) }));
  const byId = new Map(indexed.map((entry) => [entry.id, entry.node]));
  const current = byId.get(currentId) || message;
  if (String(current?.role || message?.role || "") !== "user") {
    return { currentId, index: 1, total: 1, previousId: null, nextId: null, variants: [currentId] };
  }

  // 消息不在对话图节点中（conversation 尚未更新，如刚发送但未持久化到会话图时），
  // 无法确定正确的版本分组，直接返回 total=1 避免误匹配到 parentId=null 的旧消息。
  if (!byId.has(currentId)) {
    return { currentId, index: 1, total: 1, previousId: null, nextId: null, variants: [currentId] };
  }

  const explicitGroup = revisionGroupId(current);
  const currentParentId = parentId(current);
  const currentRootId = revisionRootId(current, byId);
  const variants = indexed.filter(({ node }) => {
    if (String(node?.role || "") !== "user" || node?.deleted) return false;
    if (explicitGroup) return revisionGroupId(node) === explicitGroup;
    if (parentId(node) === currentParentId) return true;
    return revisionRootId(node, byId) === currentRootId;
  }).sort((left, right) => {
    const orderDelta = Number(left.node?.revisionIndex ?? left.node?.revision_index ?? NaN)
      - Number(right.node?.revisionIndex ?? right.node?.revision_index ?? NaN);
    if (Number.isFinite(orderDelta) && orderDelta !== 0) return orderDelta;
    return createdAtValue(left.node, left.index) - createdAtValue(right.node, right.index);
  }).map(({ id }) => id);

  if (!variants.includes(currentId)) variants.push(currentId);
  const activeIndex = Math.max(0, variants.indexOf(currentId));
  return {
    currentId,
    index: activeIndex + 1,
    total: variants.length,
    previousId: activeIndex > 0 ? variants[activeIndex - 1] : null,
    nextId: activeIndex < variants.length - 1 ? variants[activeIndex + 1] : null,
    variants,
  };
}

export function userRevisionNavigation(conversation, message, fallbackIndex = 0) {
  return messageRevisionNavigation(conversation, message, fallbackIndex);
}
