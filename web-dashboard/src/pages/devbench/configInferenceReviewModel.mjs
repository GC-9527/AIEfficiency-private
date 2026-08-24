function value(input) {
  return input === undefined || input === null ? "" : String(input);
}

/** AI/外部来源字段只允许可读标量进入表单，避免异常对象显示为 [object Object]。 */
export function configInferenceDisplayText(input) {
  if (!["string", "number", "boolean"].includes(typeof input)) return "";
  const normalized = String(input).trim();
  return normalized === "[object Object]" ? "" : normalized;
}

const REVIEW_DECISIONS = new Set(["correct", "corrected", "insufficient", "ticket_wrong"]);

/**
 * “信息不足”或空目标预测不能默认成“推理正确”。否则用户直接点“确认并继续”时，
 * 后端会按正向配置复核校验空目标并拒绝，入口被卡在弹窗里。
 */
export function defaultConfigInferenceReviewDecision(session = {}, reviewDraft = null, resolutionMode = false) {
  if (resolutionMode) return "corrected";
  const draftDecision = value(reviewDraft?.decision).trim();
  if (REVIEW_DECISIONS.has(draftDecision)) return draftDecision;
  const prediction = session?.prediction || {};
  const targets = Array.isArray(prediction.targets) ? prediction.targets : [];
  return value(prediction.status).trim().toUpperCase() === "NEED_MORE_INFO" || targets.length === 0
    ? "insufficient"
    : "correct";
}

export function defaultConfigInferenceReviewRating(decision, reviewDraft = null) {
  const explicit = Number(reviewDraft?.rating);
  if (Number.isFinite(explicit) && explicit >= 1 && explicit <= 5) return explicit;
  if (decision === "correct") return 5;
  if (decision === "corrected") return 3;
  return 1;
}

/**
 * 标识一次需要独立人工确认的预测修订。
 * run id 不变但后端原位刷新时，revision/version/updatedAt 会改变，表格必须重置。
 */
export function configInferenceSessionKey(session = {}) {
  const prediction = session?.prediction || {};
  const ticket = session?.ticket || {};
  return [
    session?.id || session?.sessionId || prediction?.id || "",
    ticket?.id || ticket?.tbTaskId || ticket?.ticketId || ticket?.carbId || "",
    ticket?.title || "",
    session?.version || prediction?.version || "",
    session?.registryVersion || "",
    session?.predictionRevision ?? "",
    session?.updatedAt || "",
    session?.refresh?.refreshedAt || "",
    prediction?.createdAt || prediction?.updatedAt || "",
  ].map(value).join("|");
}

/** 仅把同一个开发前复核 run 的 409 重算结果写回当前弹窗。 */
export function replaceConfigSuggestWithRefreshedSession(current, expectedRunId, response) {
  if (!response?.stale || !response?.refreshed || !response?.data) return current;
  if (!current || value(current.session?.id) !== value(expectedRunId)) return current;
  return { ...current, session: response.data };
}

export function configInferenceRunProjectId(run = {}, fallback = "") {
  return value(run?.projectId || run?.ticket?.projectId || fallback).trim();
}

/** 只携带恢复所需身份和旧预测摘要；服务端会重新读取 TB 并重新推理。 */
export function configInferenceReviewRecovery(run = {}) {
  return {
    ticket: run?.ticket && typeof run.ticket === "object" ? run.ticket : {},
    trainingSessionId: value(run?.trainingSessionId),
    expectedPrediction: run?.prediction && typeof run.prediction === "object" ? run.prediction : {},
    version: value(run?.version),
    registryVersion: value(run?.registryVersion),
    createdAt: Number(run?.createdAt || 0) || 0,
  };
}

/** 恢复后预测变化时保留人工草稿，但不替用户自动确认新预测。 */
export function recoveredReviewSession(response, reviewDraft) {
  if (!response?.recovered || !response?.data) return response?.data || null;
  return { ...response.data, _reviewDraft: reviewDraft || null };
}
