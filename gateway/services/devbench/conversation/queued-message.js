import { randomUUID } from "node:crypto";

const MAX_TEXT_LENGTH = 50_000;
const MAX_ID_LENGTH = 200;
const MAX_ATTACHMENTS = 100;
const MAX_ATTACHMENT_JSON_LENGTH = 512 * 1024;
const MAX_QUEUE_ERROR_LENGTH = 2_000;
const PROMPT_OVERLAY_DECISION_SCHEMA_VERSION = "prompt-compatibility-overlay-decision-v1";
const PROMPT_OVERLAY_VARIANT = "phase2_overlay";
const PROMPT_OVERLAY_STAGES = new Set([
  "TRIAGE",
  "REPAIR",
  "VERIFY_EXECUTE",
  "REPORT_SHORT",
  "REPORT_EXPERT",
]);
const PROMPT_OVERLAY_TEMPLATE_FILES = Object.freeze({
  TRIAGE: "triage.md",
  REPAIR: "repair.md",
  VERIFY_EXECUTE: "verify.md",
  REPORT_SHORT: "report-short.md",
  REPORT_EXPERT: "report-expert.md",
});
const PROMPT_OVERLAY_DECISION_KEYS = new Set([
  "schemaVersion",
  "selected",
  "storyId",
  "provider",
  "stageId",
  "reason",
  "rolloutHash",
  "version",
  "templateFile",
  "templateSha256",
  "promptVariant",
]);
const PROMPT_OVERLAY_SELECTED_KEYS = ["templateFile", "templateSha256"];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_DECISION_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;

function safeText(value, { required = false, maxLength = MAX_TEXT_LENGTH } = {}) {
  if (typeof value !== "string") return required ? null : "";
  const text = value.trim();
  if (required && !text) return null;
  return text.slice(0, maxLength);
}

function strictRequiredText(value, maxLength) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

function cloneAttachments(value) {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return null;
  try {
    const source = JSON.stringify(value);
    if (source.length > MAX_ATTACHMENT_JSON_LENGTH) return null;
    const cloned = JSON.parse(source);
    return Array.isArray(cloned) ? cloned : null;
  } catch {
    return null;
  }
}

function normalizeMessageInput(value, fallbackText) {
  if (value == null) return { text: fallbackText };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const text = safeText(value.text ?? fallbackText, { maxLength: MAX_TEXT_LENGTH });
  const attachments = cloneAttachments(value.attachments);
  if (attachments === null) return null;
  const replyToMessageId = safeText(value.replyToMessageId, { maxLength: MAX_ID_LENGTH });
  const clientMessageId = safeText(value.clientMessageId, { maxLength: MAX_ID_LENGTH });
  return {
    text: text || fallbackText,
    ...(replyToMessageId ? { replyToMessageId } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
  };
}

function normalizePromptOverlayDecision(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !PROMPT_OVERLAY_DECISION_KEYS.has(key))) return null;
  if (typeof value.selected !== "boolean") return null;

  const selected = value.selected;
  const schemaVersion = strictRequiredText(value.schemaVersion, 80);
  const storyId = strictRequiredText(value.storyId, MAX_ID_LENGTH);
  const providerText = strictRequiredText(value.provider, 100);
  const stageIdText = strictRequiredText(value.stageId, 40);
  const reasonText = strictRequiredText(value.reason, 80);
  const rolloutHashText = strictRequiredText(value.rolloutHash, 64);
  const promptVariantText = strictRequiredText(value.promptVariant, 80);
  const provider = providerText?.toLowerCase();
  const stageId = stageIdText?.toUpperCase();
  const reason = reasonText?.toLowerCase();
  const rolloutHash = rolloutHashText?.toLowerCase();
  const promptVariant = promptVariantText?.toLowerCase();
  const version = strictRequiredText(value.version, 128);
  if (schemaVersion !== PROMPT_OVERLAY_DECISION_SCHEMA_VERSION
    || !storyId
    || !provider || !SAFE_DECISION_TOKEN_PATTERN.test(provider)
    || !PROMPT_OVERLAY_STAGES.has(stageId)
    || !reason || !SAFE_DECISION_TOKEN_PATTERN.test(reason)
    || !SHA256_PATTERN.test(rolloutHash)
    || promptVariant !== PROMPT_OVERLAY_VARIANT
    || !version || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)
    || (selected ? reason !== "enabled" : reason === "enabled")) return null;

  const hasSelectedField = PROMPT_OVERLAY_SELECTED_KEYS.some((key) => Object.hasOwn(value, key));
  if (!selected) {
    if (hasSelectedField) return null;
    return {
      schemaVersion,
      selected,
      storyId,
      provider,
      stageId,
      reason,
      rolloutHash,
      version,
      promptVariant,
    };
  }

  const templateFile = strictRequiredText(value.templateFile, 160);
  const templateSha256Text = strictRequiredText(value.templateSha256, 64);
  const templateSha256 = templateSha256Text?.toLowerCase();
  if (templateFile !== PROMPT_OVERLAY_TEMPLATE_FILES[stageId]
    || !SHA256_PATTERN.test(templateSha256)) return null;
  return {
    schemaVersion,
    selected,
    storyId,
    provider,
    stageId,
    reason,
    rolloutHash,
    version,
    templateFile,
    templateSha256,
    promptVariant,
  };
}

function normalizeRuntimeOptions(value = {}) {
  const workflowKind = safeText(value.workflowKind, { maxLength: 80 });
  const deviceRuntimeRequestId = safeText(value.deviceRuntimeRequestId, { maxLength: MAX_ID_LENGTH });
  const deviceRuntimeTaskId = safeText(value.deviceRuntimeTaskId, { maxLength: MAX_ID_LENGTH });
  const workflowV2AttemptId = safeText(value.workflowV2AttemptId, { maxLength: MAX_ID_LENGTH });
  const workflowV2UserMessageId = safeText(value.workflowV2UserMessageId, { maxLength: MAX_ID_LENGTH });
  const effectiveReportMode = ["short", "expert"].includes(String(value.effectiveReportMode || "").toLowerCase())
    ? String(value.effectiveReportMode).toLowerCase()
    : "";
  let verifyDeviceAssessment;
  if (value.verifyDeviceAssessment && typeof value.verifyDeviceAssessment === "object") {
    try {
      const source = JSON.stringify(value.verifyDeviceAssessment);
      if (source.length <= 32 * 1024) verifyDeviceAssessment = JSON.parse(source);
    } catch {}
  }
  const promptOverlayDecision = normalizePromptOverlayDecision(value.promptOverlayDecision);
  if (promptOverlayDecision === null) return null;
  return {
    ...(workflowKind ? { workflowKind } : {}),
    ...(deviceRuntimeRequestId ? { deviceRuntimeRequestId } : {}),
    ...(deviceRuntimeTaskId ? { deviceRuntimeTaskId } : {}),
    ...(workflowV2AttemptId ? { workflowV2AttemptId } : {}),
    ...(workflowV2UserMessageId ? { workflowV2UserMessageId } : {}),
    ...(effectiveReportMode ? { effectiveReportMode } : {}),
    ...(verifyDeviceAssessment ? { verifyDeviceAssessment } : {}),
    ...(promptOverlayDecision ? { promptOverlayDecision } : {}),
  };
}

function normalizeDeliveryState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.status !== "blocked") return undefined;
  const code = safeText(value.code, { maxLength: MAX_ID_LENGTH }) || "QUEUED_MESSAGE_BLOCKED";
  const error = safeText(value.error, { maxLength: MAX_QUEUE_ERROR_LENGTH }) || "队列消息在派发前被阻断";
  const blockedAt = Number(value.blockedAt);
  return {
    status: "blocked",
    code,
    error,
    blockedAt: Number.isSafeInteger(blockedAt) && blockedAt >= 0 ? blockedAt : 0,
    retryable: value.retryable !== false,
  };
}

function normalizeConversationOptions(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const mode = value.mode === "edit" ? "edit" : "";
  const messageId = safeText(value.messageId, { maxLength: MAX_ID_LENGTH });
  const idempotencyKey = safeText(value.idempotencyKey, { maxLength: MAX_ID_LENGTH });
  const expectedRevision = Number(value.expectedRevision);
  return {
    ...(mode ? { mode } : {}),
    ...(messageId ? { messageId } : {}),
    ...(Number.isInteger(expectedRevision) && expectedRevision >= 0 ? { expectedRevision } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(value.forceFreshSession === true ? { forceFreshSession: true } : {}),
  };
}

export function normalizeQueuedMessage(value) {
  if (typeof value === "string") {
    const content = safeText(value, { required: true });
    return content ? { content, displayContent: content, messageInput: { text: content } } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fallback = typeof value.messageInput?.text === "string"
    ? value.messageInput.text
    : value.displayContent;
  const content = safeText(value.content ?? fallback, { required: true });
  if (!content) return null;
  const displayContent = safeText(value.displayContent ?? fallback ?? content) || content;
  const messageInput = normalizeMessageInput(value.messageInput, displayContent);
  if (!messageInput) return null;
  const conversation = normalizeConversationOptions(value.conversation);
  const deliveryState = normalizeDeliveryState(value.deliveryState);
  const runtimeOptions = normalizeRuntimeOptions(value);
  if (!runtimeOptions) return null;
  return {
    content,
    displayContent,
    messageInput,
    ...(Object.keys(conversation).length ? { conversation } : {}),
    ...runtimeOptions,
    ...(deliveryState ? { deliveryState } : {}),
  };
}

export function createQueuedMessage(value) {
  const normalized = normalizeQueuedMessage(value);
  if (normalized) return normalized;
  const error = new Error("排队消息格式无效");
  error.code = "QUEUED_MESSAGE_INVALID";
  error.statusCode = 400;
  throw error;
}

export function queuedMessageToSendTurn(value) {
  const message = normalizeQueuedMessage(value);
  if (!message) return null;
  const runtimeOptions = normalizeRuntimeOptions(message);
  if (!runtimeOptions) return null;
  const conversationOptions = normalizeConversationOptions(message.conversation);
  return {
    content: message.content,
    options: {
      conversation: {
        displayContent: message.displayContent,
        messageInput: message.messageInput,
        ...conversationOptions,
      },
      ...runtimeOptions,
      fromPersistentQueue: true,
    },
  };
}

export function ensureQueuedMessageRuntimeIdentity(value, {
  storyId,
  idFactory = randomUUID,
  forceNew = false,
} = {}) {
  const message = createQueuedMessage(value);
  if (!forceNew && message.deviceRuntimeRequestId && message.deviceRuntimeTaskId
    && message.workflowV2AttemptId && message.workflowV2UserMessageId) return message;
  const normalizedStoryId = safeText(storyId, { required: true, maxLength: MAX_ID_LENGTH });
  if (!normalizedStoryId || typeof idFactory !== "function") {
    const error = new Error("持久消息缺少可生成设备运行时身份的故事点信息");
    error.code = "QUEUED_MESSAGE_RUNTIME_IDENTITY_INVALID";
    error.statusCode = 400;
    throw error;
  }
  const taskId = !forceNew && message.deviceRuntimeTaskId
    ? message.deviceRuntimeTaskId
    : safeText(idFactory(), { required: true, maxLength: 100 });
  if (!taskId) {
    const error = new Error("设备运行时任务 ID 生成失败");
    error.code = "QUEUED_MESSAGE_RUNTIME_IDENTITY_INVALID";
    error.statusCode = 500;
    throw error;
  }
  const storyPrefixLength = Math.max(1, MAX_ID_LENGTH - taskId.length - "story::".length);
  const workflowV2AttemptId = !forceNew && message.workflowV2AttemptId
    ? message.workflowV2AttemptId
    : safeText(idFactory(), { required: true, maxLength: 100 });
  const workflowV2UserMessageId = !forceNew && message.workflowV2UserMessageId
    ? message.workflowV2UserMessageId
    : safeText(idFactory(), { required: true, maxLength: 100 });
  if (!workflowV2AttemptId || !workflowV2UserMessageId) {
    const error = new Error("持久消息 v2 派发身份生成失败");
    error.code = "QUEUED_MESSAGE_RUNTIME_IDENTITY_INVALID";
    error.statusCode = 500;
    throw error;
  }
  return {
    ...message,
    deviceRuntimeRequestId: !forceNew && message.deviceRuntimeRequestId
      ? message.deviceRuntimeRequestId
      : `story:${normalizedStoryId.slice(0, storyPrefixLength)}:${taskId}`,
    deviceRuntimeTaskId: taskId,
    workflowV2AttemptId,
    workflowV2UserMessageId,
  };
}

export function rotateQueuedMessageDeviceRequestId(value, {
  storyId,
  idFactory = randomUUID,
} = {}) {
  const message = createQueuedMessage(value);
  const normalizedStoryId = safeText(storyId, { required: true, maxLength: MAX_ID_LENGTH });
  const taskId = safeText(message.deviceRuntimeTaskId, { required: true, maxLength: 100 });
  const retryId = typeof idFactory === "function"
    ? safeText(idFactory(), { required: true, maxLength: 40 })
    : null;
  if (!normalizedStoryId || !taskId || !retryId
    || !message.workflowV2AttemptId || !message.workflowV2UserMessageId) {
    const error = new Error("持久消息缺少可轮换设备请求的冻结工作流身份");
    error.code = "QUEUED_MESSAGE_DEVICE_REQUEST_ROTATION_INVALID";
    error.statusCode = 400;
    throw error;
  }
  const suffix = `:${taskId}:retry:${retryId}`;
  const prefixLength = Math.max(1, MAX_ID_LENGTH - "story:".length - suffix.length);
  return {
    ...message,
    deviceRuntimeRequestId: `story:${normalizedStoryId.slice(0, prefixLength)}${suffix}`,
  };
}

export function markQueuedMessageBlocked(value, {
  code,
  error,
  now = Date.now(),
} = {}) {
  const message = createQueuedMessage(value);
  const normalizedCode = safeText(code, { maxLength: MAX_ID_LENGTH }) || "QUEUED_MESSAGE_BLOCKED";
  const normalizedError = safeText(error, { maxLength: MAX_QUEUE_ERROR_LENGTH }) || "队列消息在派发前被阻断";
  const blockedAt = Number(now);
  return {
    ...message,
    deliveryState: {
      status: "blocked",
      code: normalizedCode,
      error: normalizedError,
      blockedAt: Number.isSafeInteger(blockedAt) && blockedAt >= 0 ? blockedAt : 0,
      retryable: true,
    },
  };
}

export function retryBlockedQueuedMessage(value, {
  storyId,
  idFactory = randomUUID,
} = {}) {
  const message = createQueuedMessage(value);
  if (message.deliveryState?.status !== "blocked" || message.deliveryState.retryable !== true) {
    const error = new Error("队列消息当前不处于可重试阻断状态");
    error.code = "QUEUED_MESSAGE_NOT_RETRYABLE";
    error.statusCode = 409;
    throw error;
  }
  const rotated = rotateQueuedMessageDeviceRequestId(message, { storyId, idFactory });
  const { deliveryState: _deliveryState, ...retryable } = rotated;
  return retryable;
}

export function isQueuedMessageBlocked(value) {
  return normalizeQueuedMessage(value)?.deliveryState?.status === "blocked";
}

export function takeNextQueuedMessage(queue) {
  const items = Array.isArray(queue) ? queue : [];
  if (!items.length) return null;
  return {
    raw: items[0],
    request: queuedMessageToSendTurn(items[0]),
    remaining: items.slice(1),
  };
}

export function queuedMessagesEqual(left, right) {
  const normalizedLeft = normalizeQueuedMessage(left);
  const normalizedRight = normalizeQueuedMessage(right);
  if (!normalizedLeft || !normalizedRight) return left === right;
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}
