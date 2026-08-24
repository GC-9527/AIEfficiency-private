import { createHash } from "node:crypto";
import path from "node:path";

export const AttachmentPrepareState = Object.freeze({
  READY: "READY",
  NEEDS_ATTACHMENT_SELECTION: "NEEDS_ATTACHMENT_SELECTION",
  ATTACHMENTS_DOWNLOADING: "ATTACHMENTS_DOWNLOADING",
  BLOCKED: "BLOCKED",
});

const SECRET_KEY_RE = /(?:^|[_-])(authorization|cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|signature|credential|security[_-]?token)(?:$|[_-])/i;
const SECRET_QUERY_RE = /([?&](?:token|access_token|refresh_token|signature|x-amz-signature|x-oss-signature|credential|security-token)=)[^&#\s]*/gi;
const URL_WITH_SECRET_RE = /https?:\/\/[^\s"'<>]+[?&](?:token|access_token|refresh_token|signature|x-amz-signature|x-oss-signature|credential|security-token)=/i;

export class ToolkitError extends Error {
  constructor(code, message, details = null) {
    super(redactErrorMessage(message));
    this.name = "ToolkitError";
    this.code = String(code || "TOOLKIT_ERROR");
    if (details != null) this.details = redactSecrets(details);
  }
}

export function redactErrorMessage(value) {
  let text = String(value?.message || value || "未知错误");
  text = text.replace(SECRET_QUERY_RE, "$1[REDACTED]");
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => (URL_WITH_SECRET_RE.test(url) ? "[REDACTED_URL]" : url));
  text = text.replace(/(?:Bearer\s+|Cookie:\s*)[^\s,;]+/gi, "[REDACTED]");
  return text;
}

export function redactSecrets(value, seen = new WeakSet()) {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactErrorMessage(value);
  if (Buffer.isBuffer(value)) return `[BUFFER:${value.length}]`;
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) continue;
    if (/^(?:downloadUrl|signed|url)$/i.test(key) && typeof item === "string" && URL_WITH_SECRET_RE.test(item)) continue;
    output[key] = redactSecrets(item, seen);
  }
  seen.delete(value);
  return output;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex");
}

export function normalizeTaskNo(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,31}-\d{1,20}$/.test(normalized)) {
    throw new ToolkitError("TASK_NO_REQUIRED", "缺少可识别的 TB 单号，不能用标题代替");
  }
  return normalized;
}

export function sanitizeAttachmentName(value, { fallback = "attachment" } = {}) {
  const normalizedSeparators = String(value || "").replace(/\\/g, "/");
  let name = path.posix.basename(normalizedSeparators)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!name || name === "." || name === "..") name = fallback;
  const stem = name.split(".")[0];
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:$|[ ._])/i.test(stem)) name = `_${name}`;
  if (name.length > 180) {
    const ext = path.extname(name).slice(0, 24);
    const base = path.basename(name, path.extname(name)).slice(0, Math.max(1, 180 - ext.length - 10));
    name = `${base}-${sha256(name).slice(0, 8)}${ext}`;
  }
  return name;
}

function stringValue(...values) {
  for (const value of values) {
    if (value != null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function idName(value, fallbackId = "") {
  if (!value || typeof value !== "object") {
    const scalar = stringValue(value);
    return scalar ? { id: fallbackId || scalar, name: scalar } : null;
  }
  const id = stringValue(value.id, value._id, value.userId, fallbackId);
  const name = stringValue(value.name, value.title, value.displayName, value.nickName, value.label);
  return id || name ? redactSecrets({ id: id || null, name: name || null }) : null;
}

function normalizeComment(comment, index) {
  const rawContent = comment?.content;
  const content = typeof rawContent === "object" && rawContent != null
    ? stringValue(rawContent.text, rawContent.markdown, rawContent.html, rawContent.content, JSON.stringify(redactSecrets(rawContent)))
    : stringValue(rawContent, comment?.text, comment?.body, comment?.message);
  return redactSecrets({
    commentId: stringValue(comment?._id, comment?.id) || `comment-${index + 1}`,
    content,
    author: idName(comment?.creator || comment?.author || comment?.user, stringValue(comment?.creatorId, comment?._creatorId)),
    createdAt: stringValue(comment?.createdAt, comment?.created, comment?.time) || null,
    updatedAt: stringValue(comment?.updatedAt, comment?.updated) || null,
  });
}

function normalizeCustomField(field, index) {
  const definition = field?.customfield || field?.customField || field?.field || {};
  return redactSecrets({
    id: stringValue(field?.id, field?._id, field?.customfieldId, field?._customfieldId, definition?.id, definition?._id) || `custom-field-${index + 1}`,
    name: stringValue(field?.name, field?.title, definition?.name, definition?.title) || null,
    value: field?.value ?? field?.values ?? field?.selected ?? null,
  });
}

function attachmentSource(value, fallback = "other") {
  const source = String(value || "").toLowerCase();
  return ["task", "description", "remark", "comment", "other"].includes(source) ? source : fallback;
}

function normalizeAttachment(item, index, fallbackSource = "other") {
  const attachmentId = stringValue(item?.attachmentId, item?.id, item?._id)
    || `attachment-${sha256(`${fallbackSource}\0${index}\0${stringValue(item?.originalName, item?.fileName, item?.name)}`).slice(0, 16)}`;
  return {
    attachmentId,
    source: attachmentSource(item?.source || item?._source, fallbackSource),
    sourceRef: stringValue(item?.sourceRef, item?._sourceRef) || null,
    originalName: sanitizeAttachmentName(stringValue(item?.originalName, item?.fileName, item?.name), { fallback: `attachment-${index + 1}` }),
    size: Number.isFinite(Number(item?.size ?? item?.fileSize)) ? Math.max(0, Number(item?.size ?? item?.fileSize)) : null,
    mimeType: stringValue(item?.mimeType, item?.contentType, item?.type) || null,
    uploader: stringValue(item?.uploader?.name, item?.uploader, item?.creator?.name, item?.creatorName) || null,
    createdAt: stringValue(item?.createdAt, item?.created, item?._createdAt) || null,
    selected: false,
    downloadStatus: "NOT_SELECTED",
    localRelativePath: null,
    sha256: null,
    errorCode: null,
  };
}

export function normalizeAttachments(snapshot = {}) {
  const candidates = [];
  const push = (items, source) => {
    for (const item of Array.isArray(items) ? items : []) candidates.push(normalizeAttachment(item, candidates.length, source));
  };
  push(snapshot?.attachments?.items, "task");
  push(snapshot?.detail?.attachments, "task");
  push(snapshot?.detail?.descriptionAttachments, "description");
  for (const comment of Array.isArray(snapshot?.comments?.items) ? snapshot.comments.items : []) {
    const content = comment?.content && typeof comment.content === "object" ? comment.content : {};
    const files = Array.isArray(content.files) ? content.files : (Array.isArray(comment?.attachments) ? comment.attachments : []);
    for (const file of files) {
      candidates.push(normalizeAttachment({ ...file, sourceRef: stringValue(comment?._id, comment?.id) }, candidates.length, "comment"));
    }
  }
  push(snapshot?.note?.images, "remark");
  const positions = new Map();
  const output = [];
  for (const item of candidates) {
    const key = `id:${item.attachmentId}`;
    if (!positions.has(key)) {
      positions.set(key, output.length);
      output.push(item);
      continue;
    }
    const index = positions.get(key);
    output[index] = { ...output[index], ...Object.fromEntries(Object.entries(item).filter(([, value]) => value != null && value !== "")) };
  }
  return output;
}

function markUnavailable(unavailableFields, field, reason) {
  unavailableFields.push({ field, reason: redactErrorMessage(reason || "上游未提供该字段") });
}

export function attachmentManifestDigest(attachments = []) {
  const stable = attachments.map((item) => ({
    attachmentId: item.attachmentId,
    source: item.source,
    sourceRef: item.sourceRef ?? null,
    originalName: item.originalName,
    size: item.size ?? null,
    mimeType: item.mimeType ?? null,
    uploader: item.uploader ?? null,
    createdAt: item.createdAt ?? null,
  }));
  return sha256(stableStringify(stable));
}

export function normalizeTicketContext(snapshot = {}, { collectedAt = new Date().toISOString() } = {}) {
  const resolved = snapshot.resolved || {};
  const detail = snapshot.detail || {};
  const taskId = stringValue(resolved.taskId, resolved.tbTaskId, detail.taskId, detail._id, detail.id);
  const taskNo = normalizeTaskNo(stringValue(resolved.taskNo, resolved.carbId, detail.taskNo, detail.uniqueId ? `CARB-${detail.uniqueId}` : ""));
  if (!taskId) throw new ToolkitError("TASK_ID_REQUIRED", "未解析到唯一 TB taskId");
  const unavailableFields = [];

  const descriptionRaw = detail.note ?? detail.description ?? null;
  let description = null;
  if (descriptionRaw != null && descriptionRaw !== "") {
    description = typeof descriptionRaw === "object"
      ? { value: redactSecrets(descriptionRaw), provenance: { source: "task-detail", field: detail.note != null ? "note" : "description" } }
      : { value: String(descriptionRaw), provenance: { source: "task-detail", field: detail.note != null ? "note" : "description" } };
  } else {
    markUnavailable(unavailableFields, "description", "任务详情未返回描述/正文");
  }

  const remarks = [];
  if (snapshot.note?.ok && (snapshot.note.markdown || snapshot.note.html)) {
    remarks.push(redactSecrets({
      renderMode: snapshot.note.renderMode || null,
      markdown: snapshot.note.markdown || "",
      html: snapshot.note.html || "",
      links: snapshot.note.links || [],
      provenance: { source: "task-note" },
    }));
  } else {
    markUnavailable(unavailableFields, "remarks", snapshot.note?.error || "备注接口不可用");
  }

  const commentsAvailable = snapshot.comments?.available === true;
  const comments = commentsAvailable
    ? (snapshot.comments.items || []).map(normalizeComment)
    : [];
  if (!commentsAvailable) markUnavailable(unavailableFields, "comments", snapshot.comments?.error || "评论接口不可用");

  const project = idName(detail.project, stringValue(detail.projectId, detail._projectId));
  if (!project) markUnavailable(unavailableFields, "project", "任务详情未返回项目");
  const iteration = idName(detail.sprint || detail.iteration, stringValue(detail.sprintId, detail._sprintId));
  if (!iteration) markUnavailable(unavailableFields, "iteration", "任务详情未返回迭代");
  const priorityValue = detail.priority ?? detail.priorityName ?? null;
  const priority = priorityValue != null && priorityValue !== "" ? { value: redactSecrets(priorityValue), provenance: { source: "task-detail" } } : null;
  if (!priority) markUnavailable(unavailableFields, "priority", "任务详情未返回优先级");

  const rawLabels = detail.tags || detail.tagNames || [];
  const labels = (Array.isArray(rawLabels) ? rawLabels : []).map((item) => idName(item)).filter(Boolean);
  if (!Array.isArray(rawLabels)) markUnavailable(unavailableFields, "labels", "任务详情未返回标签集合");

  const creator = idName(detail.creator, stringValue(detail.creatorId, detail._creatorId));
  const executor = idName(detail.executor, stringValue(detail.executorId, detail._executorId));
  const participantRaw = detail.involveMembers || detail.participants || [];
  const participants = (Array.isArray(participantRaw) ? participantRaw : []).map((item) => idName(item)).filter(Boolean);
  const people = { creator, executor, participants };
  if (!creator) markUnavailable(unavailableFields, "people.creator", "任务详情未返回创建人");
  if (!executor) markUnavailable(unavailableFields, "people.executor", "任务详情未返回负责人");
  if (!Array.isArray(participantRaw)) markUnavailable(unavailableFields, "people.participants", "任务详情未返回参与人集合");

  const rawCustomFields = detail.customfields || detail.customFields || detail.scenariofields || [];
  const customFields = (Array.isArray(rawCustomFields) ? rawCustomFields : []).map(normalizeCustomField);
  if (!Array.isArray(rawCustomFields)) markUnavailable(unavailableFields, "customFields", "任务详情未返回自定义字段集合");

  const relationRaw = detail.relations || detail.dependencies || detail.relatedTasks;
  const relations = Array.isArray(relationRaw) ? redactSecrets(relationRaw) : [];
  if (!Array.isArray(relationRaw)) markUnavailable(unavailableFields, "relations", "当前已审计接口不支持完整父子/关联/依赖关系");

  const status = detail.taskflowstatus || detail.tfs || null;
  const currentStatus = status || detail.isDone != null ? {
    rawId: stringValue(status?._id, status?.id, detail.taskflowstatusId, detail._taskflowstatusId) || null,
    rawName: stringValue(status?.name, status?.title) || null,
    isDone: detail.isDone === true,
    derivedLifecycle: detail.isDone === true ? "DONE" : "ACTIVE_OR_UNKNOWN",
  } : null;
  if (!currentStatus?.rawName) markUnavailable(unavailableFields, "task.currentStatus.rawName", "任务详情未返回原始工作流状态名");

  const attachments = normalizeAttachments(snapshot);
  if (snapshot.attachments?.available !== true) {
    markUnavailable(unavailableFields, "attachments", snapshot.attachments?.error || "附件接口不可用");
  } else if (snapshot.attachments?.complete !== true) {
    markUnavailable(unavailableFields, "attachments.completeness", snapshot.attachments?.error || "附件结果不完整");
  }

  const context = {
    schemaVersion: 2,
    task: {
      taskId,
      taskNo,
      title: stringValue(resolved.title, detail.content, detail.title),
      currentStatus,
      createdAt: stringValue(detail.createdAt, detail.created) || null,
      updatedAt: stringValue(detail.updatedAt, detail.updated) || null,
      dueAt: stringValue(detail.dueDate, detail.dueAt) || null,
      versionToken: stringValue(detail.versionToken, detail.updatedAt, detail.updated) || null,
    },
    fields: {
      description,
      remarks,
      comments,
      project,
      iteration,
      priority,
      labels,
      people,
      customFields,
      relations,
      aiefficiencyContext: redactSecrets(snapshot.aiefficiencyContext ?? null),
      sourceCoverage: redactSecrets({
        comments: snapshot.comments ? {
          available: snapshot.comments.available === true,
          complete: snapshot.comments.complete === true,
          source: snapshot.comments.source || "none",
          count: comments.length,
          error: snapshot.comments.error || "",
        } : null,
        attachments: snapshot.attachments ? {
          available: snapshot.attachments.available === true,
          complete: snapshot.attachments.complete === true,
          source: snapshot.attachments.source || "none",
          count: attachments.length,
          error: snapshot.attachments.error || "",
        } : null,
      }),
    },
    unavailableFields,
    attachments,
    contextDigest: "",
    collectedAt: String(collectedAt),
  };
  const digestInput = structuredClone(context);
  delete digestInput.collectedAt;
  delete digestInput.contextDigest;
  context.contextDigest = sha256(stableStringify(digestInput));
  return context;
}

function selectionChoices(attachments) {
  return attachments.map((item, index) => ({
    index: index + 1,
    attachmentId: item.attachmentId,
    name: item.originalName,
    source: item.source,
    size: item.size ?? null,
    mimeType: item.mimeType ?? null,
    uploader: item.uploader ?? null,
    createdAt: item.createdAt ?? null,
  }));
}

function validateSelectedIds(ids, attachments) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => !String(id || "").trim())) {
    throw new ToolkitError("ATTACHMENT_SELECTION_INVALID", "附件选择必须包含至少一个有效 attachmentId");
  }
  const normalized = ids.map((id) => String(id).trim());
  if (new Set(normalized).size !== normalized.length) {
    throw new ToolkitError("ATTACHMENT_SELECTION_DUPLICATE", "附件选择包含重复 attachmentId");
  }
  const available = new Set(attachments.map((item) => item.attachmentId));
  const unknown = normalized.filter((id) => !available.has(id));
  if (unknown.length) throw new ToolkitError("ATTACHMENT_SELECTION_INVALID", "附件选择包含未知或过期 attachmentId", { attachmentIds: unknown });
  return normalized;
}

export function decideAttachmentSelection(attachments = [], { selection = null, savedSelection = null, autoDownloadMaxCount = 3 } = {}) {
  const items = Array.isArray(attachments) ? attachments : [];
  const manifestDigest = attachmentManifestDigest(items);
  const choices = selectionChoices(items);
  let selectedIds = null;
  let mode = null;
  let restored = false;

  if (selection) {
    mode = selection.mode;
    if (mode === "all") selectedIds = items.map((item) => item.attachmentId);
    else if (mode === "selected") selectedIds = validateSelectedIds(selection.attachmentIds, items);
    else throw new ToolkitError("ATTACHMENT_SELECTION_INVALID", "附件选择 mode 只能是 selected 或 all");
  } else if (savedSelection) {
    if (savedSelection.manifestDigest !== manifestDigest) {
      throw new ToolkitError("ATTACHMENT_SELECTION_STALE", "已保存的附件选择与当前附件清单不一致");
    }
    mode = savedSelection.mode;
    selectedIds = items.length === 0 && Array.isArray(savedSelection.attachmentIds) && savedSelection.attachmentIds.length === 0
      ? []
      : validateSelectedIds(savedSelection.attachmentIds, items);
    restored = true;
  } else if (items.length <= autoDownloadMaxCount) {
    mode = "auto";
    selectedIds = items.map((item) => item.attachmentId);
  } else {
    return {
      state: AttachmentPrepareState.NEEDS_ATTACHMENT_SELECTION,
      manifestDigest,
      selectedIds: [],
      choices,
      restored: false,
      selectionReceipt: null,
    };
  }

  const selectionReceipt = {
    schemaVersion: 1,
    manifestDigest,
    mode,
    attachmentIds: selectedIds,
  };
  return {
    state: AttachmentPrepareState.READY,
    manifestDigest,
    selectedIds,
    choices,
    restored,
    selectionReceipt,
  };
}

export function assignAttachmentLocalNames(attachments = []) {
  const entries = attachments.map((item, index) => ({
    item,
    index,
    baseName: sanitizeAttachmentName(item.originalName, { fallback: `attachment-${index + 1}` }),
  }));
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.baseName.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const assigned = new Map();
  const used = new Set();
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => String(a.item.attachmentId).localeCompare(String(b.item.attachmentId)) || a.index - b.index);
    for (const [position, entry] of ordered.entries()) {
      const ext = path.extname(entry.baseName);
      const stem = path.basename(entry.baseName, ext);
      let candidate = position === 0 ? entry.baseName : `${stem}--${sha256(entry.item.attachmentId).slice(0, 8)}${ext}`;
      let attempt = 1;
      while (used.has(candidate.toLowerCase())) {
        attempt += 1;
        candidate = `${stem}--${sha256(`${entry.item.attachmentId}:${attempt}`).slice(0, 8)}${ext}`;
      }
      used.add(candidate.toLowerCase());
      assigned.set(entry.index, candidate);
    }
  }
  return attachments.map((item, index) => ({ ...item, localName: assigned.get(index) }));
}

export const UpdatePhase = Object.freeze({ TRIAGE: "TRIAGE", RESOLUTION: "RESOLUTION" });
export const ToolkitOperationState = Object.freeze({
  PLANNED: "PLANNED",
  APPLYING: "APPLYING",
  COMMENT_APPLIED: "COMMENT_APPLIED",
  STATUS_APPLIED: "STATUS_APPLIED",
  COMPLETED: "COMPLETED",
  PARTIAL: "PARTIAL",
  FAILED: "FAILED",
  CONFLICT: "CONFLICT",
});

export const COMMENT_FORBIDDEN_PHRASES = Object.freeze([
  "经AI分析", "根据您提供的信息", "作为AI", "我认为", "建议您", "进一步分析", "深入分析",
  "综上所述", "总体来看", "可能是", "大概率", "本次修复", "问题已成功解决", "我们将", "希望能够",
]);

const TRIAGE_COMPLETION_RE = /(?:已修复|已解决|全部通过|测试已通过|构建已通过|问题解决|修复完成)/i;
const MARKDOWN_OR_MULTILINE_RE = /(?:\r|\n|^\s{0,3}#{1,6}\s|^\s*[-*+]\s|^\s*\d+[.)]\s)/m;
const SECRET_OR_PATH_RE = /(?:Authorization\s*:|Cookie\s*:|Bearer\s+[\w.-]+|[A-Za-z]:[\\/]|\/(?:Users|home|tmp|var\/tmp)\/|[?&](?:token|access_token|signature|x-amz-signature|x-oss-signature)=)/i;
const VAGUE_ONLY_RE = /^(?:排查|优化|完善|处理|关注|分析|修复|解决|改进|跟进)[。.!！ ]*$/;
const CONCRETE_ACTION_RE = /(?:读取|复现|核对|定位|新增|增加|补充|修改|调整|更新|同步|刷新|清理|移除|删除|替换|修正|校验|拦截|阻断|限制|统一|复用|接入|恢复|重试|关闭|保存|透传|回滚|验证|回归|构建|测试)/;

function normalizedPlainText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().replace(/[；;。.!！]+$/g, "");
}

function codePointLength(value) {
  return [...String(value || "")].length;
}

function assertCommentPart(name, value, maxLength) {
  const text = normalizedPlainText(value);
  if (!text) throw new ToolkitError("COMMENT_STYLE_REJECTED", `${name}不能为空`);
  if (MARKDOWN_OR_MULTILINE_RE.test(String(value || ""))) throw new ToolkitError("COMMENT_STYLE_REJECTED", `${name}必须是一行自然文本`);
  if (SECRET_OR_PATH_RE.test(text)) throw new ToolkitError("COMMENT_STYLE_REJECTED", `${name}包含秘密、签名参数或本机绝对路径`);
  const forbidden = COMMENT_FORBIDDEN_PHRASES.find((phrase) => text.includes(phrase));
  if (forbidden) throw new ToolkitError("COMMENT_STYLE_REJECTED", `${name}包含禁用表达「${forbidden}」`);
  if (codePointLength(text) > maxLength) throw new ToolkitError("COMMENT_STYLE_REJECTED", `${name}超过 ${maxLength} 字，需重新改写`);
  if (VAGUE_ONLY_RE.test(text)) throw new ToolkitError("COMMENT_STYLE_REJECTED", `${name}过于空泛`);
  return text;
}

export function formatReasonMeasure({ phase, reason, measure } = {}) {
  const normalizedPhase = String(phase || "").toUpperCase();
  if (!Object.values(UpdatePhase).includes(normalizedPhase)) throw new ToolkitError("INVALID_ARGUMENT", "phase 只能是 TRIAGE 或 RESOLUTION");
  const normalizedReason = assertCommentPart("原因", reason, 80);
  const normalizedMeasure = assertCommentPart("措施", measure, 120);
  if (normalizedPhase === UpdatePhase.TRIAGE && (TRIAGE_COMPLETION_RE.test(normalizedReason) || TRIAGE_COMPLETION_RE.test(normalizedMeasure))) {
    throw new ToolkitError("COMMENT_STYLE_REJECTED", "TRIAGE 评论不能声称已经修复或验证通过");
  }
  if (!CONCRETE_ACTION_RE.test(normalizedMeasure)) throw new ToolkitError("COMMENT_STYLE_REJECTED", "措施必须包含具体对象、动作或验证场景");
  const comment = `原因：${normalizedReason}；措施：${normalizedMeasure}。`;
  if (codePointLength(comment) > 220) throw new ToolkitError("COMMENT_STYLE_REJECTED", "评论超过 220 字，需重新改写");
  return Object.freeze({
    phase: normalizedPhase,
    reason: normalizedReason,
    measure: normalizedMeasure,
    comment,
    commentHash: sha256(comment),
    checks: ["single-line", "fixed-format", "forbidden-phrases", "sensitive-data", "length", "phase-claims", "concrete-measure"],
  });
}

export function resolveExactStatusRef(reference, statuses = []) {
  const ref = typeof reference === "string" ? { displayName: reference } : (reference || {});
  const wantedId = stringValue(ref.statusId, ref.id);
  const wantedName = stringValue(ref.displayName, ref.name, ref.statusKey);
  const rows = (Array.isArray(statuses) ? statuses : []).filter((row) => {
    const id = stringValue(row.statusId, row.id, row._id);
    const name = stringValue(row.displayName, row.name, row.title);
    return wantedId ? id === wantedId : normalizedPlainText(name).toLowerCase() === normalizedPlainText(wantedName).toLowerCase();
  });
  if (rows.length !== 1) throw new ToolkitError("INVALID_TRANSITION", rows.length ? "目标状态匹配不唯一" : "目标状态不在当前任务工作流中");
  return {
    statusId: stringValue(rows[0].statusId, rows[0].id, rows[0]._id),
    displayName: stringValue(rows[0].displayName, rows[0].name, rows[0].title),
  };
}

export function planFingerprint(value) {
  const clone = structuredClone(value || {});
  delete clone.fingerprint;
  return sha256(stableStringify(clone));
}

export function buildStableIdempotencyKey({ taskId, phase, targetStatus, comment, sourceCommitOrWorkflowRunId } = {}) {
  const scope = [taskId, phase, targetStatus?.statusId || targetStatus?.displayName, comment, sourceCommitOrWorkflowRunId]
    .map((value) => String(value || "").trim());
  if (scope.some((value) => !value)) throw new ToolkitError("INVALID_ARGUMENT", "生成幂等键所需字段不完整");
  return `tbfix:${String(phase).toLowerCase()}:${sha256(scope.join("\0"))}`;
}
