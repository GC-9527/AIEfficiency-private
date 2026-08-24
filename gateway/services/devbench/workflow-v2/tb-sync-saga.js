import { createHash } from "node:crypto";

const SAGA_SCHEMA_VERSION = "tb-sync-saga-v1";

/**
 * M9 TB 同步 Saga。所有外部写都带持久化幂等键（storyId + reportRevision +
 * contentHash / fileSha256 / 状态对），先查 ledger，再远端查重，最后写入并
 * 回读确认。任何一步模糊失败都不重写（停留 pending），本地 phase 不得提前
 * 推进到 testable/rejected。
 */

export function sha256Hex(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

export function tbSyncCommentKey({ storyId, reportRevision, content }) {
  return `comment:${String(storyId)}:${String(reportRevision)}:${sha256Hex(content)}`;
}

export function tbSyncAttachmentKey({ storyId, reportRevision, fileSha256, fileName = "" }) {
  return `attachment:${String(storyId)}:${String(reportRevision)}:${String(fileSha256)}:${String(fileName)}`;
}

function normalizeAllowedFromStatuses(allowedFromStatuses, fromStatus) {
  const source = Array.isArray(allowedFromStatuses)
    ? allowedFromStatuses
    : (String(fromStatus || "").trim() ? [fromStatus] : []);
  return [...new Set(source.map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

export function tbSyncStatusKey({ storyId, fromStatus, allowedFromStatuses, targetStatus, reportRevision }) {
  const allowed = normalizeAllowedFromStatuses(allowedFromStatuses, fromStatus);
  const sourceIdentity = Array.isArray(allowedFromStatuses)
    ? `[${allowed.join("|")}]`
    : String(fromStatus || "");
  return `status:${String(storyId)}:${sourceIdentity}->${String(targetStatus)}:${String(reportRevision)}`;
}

function normalizedLedger(ledger) {
  const source = ledger && typeof ledger === "object" ? ledger : {};
  return {
    schemaVersion: SAGA_SCHEMA_VERSION,
    reportRevision: String(source.reportRevision || ""),
    comment: source.comment && typeof source.comment === "object" ? { key: String(source.comment.key || ""), at: Number(source.comment.at || 0) } : null,
    attachment: source.attachment && typeof source.attachment === "object" ? { key: String(source.attachment.key || ""), at: Number(source.attachment.at || 0) } : null,
    status: source.status && typeof source.status === "object" ? { key: String(source.status.key || ""), at: Number(source.status.at || 0) } : null,
  };
}

function assertRemoteList(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label}未返回可确认列表`);
  }
  return value;
}

function attachmentMatches(entry, { fileName, fileSha256 }) {
  return String(entry?.fileName ?? entry?.name ?? "") === fileName
    && String(entry?.sha256 ?? "").toLowerCase() === fileSha256;
}

function isUnsettledStep(step) {
  return step?.status === "pending_ambiguous" || step?.status === "blocked";
}

function operationMeta(operation, step, stepKey, readOnly = false) {
  if (!operation || typeof operation !== "object") return undefined;
  const outbox = operation.outbox?.[step] || {};
  return Object.freeze({
    operationId: String(operation.operationId || ""),
    idempotencyKey: String(outbox.idempotencyKey || ""),
    fencingToken: Number(operation.fencingToken || 0),
    step,
    stepKey: String(outbox.key || stepKey || ""),
    readOnly: readOnly === true,
  });
}

/**
 * 执行一次 TB 同步 Saga（可重入）。api 注入：
 * { postComment(text), findComments(), uploadAttachment(absPath), findAttachments(),
 *   currentStatus(), flowStatus(target) }
 * allowedFromStatuses 会排序去重并绑定状态 operation identity；旧调用未传时回退
 * fromStatus。canonicalizeStatus 可把 TB 真实状态映射为逻辑状态参与门控和写后回读。
 * 每一步返回 { ok, skipped?, ambiguous?, reason? }；写后必须回读确认。
 */
export async function runTbSyncSaga({
  storyId,
  tbTaskId,
  reportRevision,
  shortReport,
  attachment = null,
  fromStatus = "",
  allowedFromStatuses = null,
  targetStatus = "可提测",
  canonicalizeStatus = null,
  ledger = null,
  operation = null,
  api,
} = {}) {
  const requiredApiMethods = [
    "postComment",
    "findComments",
    "uploadAttachment",
    "findAttachments",
    "currentStatus",
    "flowStatus",
  ];
  const missingApiMethods = requiredApiMethods.filter((name) => typeof api?.[name] !== "function");
  if (missingApiMethods.length > 0) {
    throw new Error(`tb-sync-saga 缺少注入的 TB API: ${missingApiMethods.join(", ")}`);
  }
  const revision = String(reportRevision || "");
  if (!revision) throw new Error("tb-sync-saga 缺少 reportRevision");
  const nextLedger = normalizedLedger(ledger);
  nextLedger.reportRevision = revision;
  const steps = { comment: { status: "unknown" }, attachment: { status: "skipped" }, status: { status: "unknown" } };
  const errors = [];

  // --- 评论：ledger → 远端查重 → 写入+回读 ---
  const commentText = String(shortReport || "").trim();
  if (commentText) {
    const commentKey = tbSyncCommentKey({ storyId, reportRevision: revision, content: commentText });
    if (nextLedger.comment?.key === commentKey) {
      steps.comment = { status: "replayed", key: commentKey };
    } else {
      let dedup = null;
      try {
        const existing = assertRemoteList(await api.findComments(operationMeta(operation, "comment", commentKey, true)), "评论查重");
        const match = existing.find((entry) => String(entry?.content ?? entry?.text ?? "") === commentText);
        if (match) dedup = { remote: true, commentId: String(match.id || match.commentId || "") };
      } catch (error) {
        steps.comment = { status: "pending_ambiguous", key: commentKey, reason: `远端查重失败: ${error.message}` };
        errors.push(`评论查重失败: ${error.message}`);
      }
      if (!isUnsettledStep(steps.comment)) {
        if (dedup) {
          nextLedger.comment = { key: commentKey, at: Date.now() };
          steps.comment = { status: "deduped_remote", key: commentKey, ...dedup };
        } else {
          try {
            await api.postComment(commentText, operationMeta(operation, "comment", commentKey));
            const confirmed = assertRemoteList(await api.findComments(operationMeta(operation, "comment", commentKey, true)), "评论写后回读");
            const found = Array.isArray(confirmed) && confirmed.some((entry) => String(entry?.content ?? entry?.text ?? "") === commentText);
            if (found) {
              nextLedger.comment = { key: commentKey, at: Date.now() };
              steps.comment = { status: "done", key: commentKey };
            } else {
              steps.comment = { status: "pending_ambiguous", key: commentKey, reason: "评论写入后回读未确认" };
              errors.push("评论写入后回读未确认，停止重写等待人工核对");
            }
          } catch (error) {
            steps.comment = { status: "pending_ambiguous", key: commentKey, reason: `评论写入失败: ${error.message}` };
            errors.push(`评论写入失败: ${error.message}`);
          }
        }
      }
    }
  } else {
    steps.comment = { status: "skipped", reason: "无评论内容" };
  }

  // --- 附件：ledger → 远端查重 → 上传+回读 ---
  if (attachment && typeof attachment.absPath === "string" && attachment.absPath) {
    const fileSha256 = String(attachment.sha256 || "").toLowerCase();
    const fileName = String(attachment.fileName || "");
    if (!fileName || !/^[a-f0-9]{64}$/.test(fileSha256)) {
      steps.attachment = { status: "blocked", reason: "附件缺少可确认的 fileName 或 sha256" };
      errors.push("附件缺少可确认的 fileName 或 sha256，拒绝上传");
    } else {
      const attachKey = tbSyncAttachmentKey({ storyId, reportRevision: revision, fileSha256, fileName });
      if (nextLedger.attachment?.key === attachKey) {
        steps.attachment = { status: "replayed", key: attachKey };
      } else {
        let deduped = false;
        try {
          const existing = assertRemoteList(await api.findAttachments(operationMeta(operation, "attachment", attachKey, true)), "附件查重");
          deduped = existing.some((entry) => attachmentMatches(entry, { fileName, fileSha256 }));
        } catch (error) {
          steps.attachment = { status: "pending_ambiguous", key: attachKey, reason: `附件查重失败: ${error.message}` };
          errors.push(`附件查重失败: ${error.message}`);
        }
        if (!isUnsettledStep(steps.attachment)) {
          if (deduped) {
            nextLedger.attachment = { key: attachKey, at: Date.now() };
            steps.attachment = { status: "deduped_remote", key: attachKey };
          } else {
            try {
              const result = await api.uploadAttachment(attachment.absPath, operationMeta(operation, "attachment", attachKey));
              const confirmed = assertRemoteList(await api.findAttachments(operationMeta(operation, "attachment", attachKey, true)), "附件写后回读")
                .some((entry) => attachmentMatches(entry, { fileName, fileSha256 }));
              if (result?.ok !== false && confirmed) {
                nextLedger.attachment = { key: attachKey, at: Date.now() };
                steps.attachment = { status: "done", key: attachKey };
              } else {
                const reason = result?.ok === false
                  ? String(result?.error || "附件上传失败")
                  : "附件上传后回读未确认同名同哈希文件";
                steps.attachment = { status: "pending_ambiguous", key: attachKey, reason };
                errors.push(reason);
              }
            } catch (error) {
              steps.attachment = { status: "pending_ambiguous", key: attachKey, reason: `附件上传或回读失败: ${error.message}` };
              errors.push(`附件上传或回读失败: ${error.message}`);
            }
          }
        }
      }
    }
  } else {
    steps.attachment = { status: "skipped", reason: "无附件" };
  }

  // --- 状态：读当前 → 已到达则跳过 → 流转+回读确认 ---
  const allowedStatuses = normalizeAllowedFromStatuses(allowedFromStatuses, fromStatus);
  const statusKey = tbSyncStatusKey({
    storyId,
    fromStatus,
    allowedFromStatuses,
    targetStatus,
    reportRevision: revision,
  });
  const unsettledPrerequisites = ["comment", "attachment"].filter((name) => isUnsettledStep(steps[name]));
  if (unsettledPrerequisites.length > 0) {
    const reason = `${unsettledPrerequisites.join("/")} 未确认，禁止流转状态`;
    steps.status = { status: "blocked", key: statusKey, reason };
    errors.push(reason);
  } else if (nextLedger.status?.key === statusKey) {
    steps.status = { status: "replayed", key: statusKey };
  } else {
    try {
      const current = String(await api.currentStatus(operationMeta(operation, "status", statusKey, true)) || "").trim();
      if (!current) throw new Error("状态查重未返回可确认状态");
      const canonicalCurrent = typeof canonicalizeStatus === "function"
        ? String(await canonicalizeStatus(current) || "").trim()
        : "";
      const alreadyAtTarget = current === targetStatus || canonicalCurrent === targetStatus;
      if (alreadyAtTarget) {
        nextLedger.status = { key: statusKey, at: Date.now() };
        steps.status = { status: "deduped_remote", key: statusKey, current, canonicalCurrent: canonicalCurrent || null };
      } else if (!allowedStatuses.includes(current) && !allowedStatuses.includes(canonicalCurrent)) {
        const reason = `当前状态不允许流转（${current}${canonicalCurrent ? ` / ${canonicalCurrent}` : ""}）`;
        steps.status = { status: "blocked", key: statusKey, current, canonicalCurrent: canonicalCurrent || null, reason };
        errors.push(reason);
      } else {
        const flowed = await api.flowStatus(targetStatus, operationMeta(operation, "status", statusKey));
        const after = String(await api.currentStatus(operationMeta(operation, "status", statusKey, true)) || "").trim();
        if (!after) throw new Error("状态流转后回读未返回可确认状态");
        const canonicalAfter = typeof canonicalizeStatus === "function"
          ? String(await canonicalizeStatus(after) || "").trim()
          : "";
        const reached = flowed?.ok !== false && (after === targetStatus || canonicalAfter === targetStatus);
        if (reached) {
          nextLedger.status = { key: statusKey, at: Date.now() };
          steps.status = {
            status: "done",
            key: statusKey,
            from: current,
            canonicalFrom: canonicalCurrent || null,
            to: after,
            canonicalTo: canonicalAfter || null,
          };
        } else {
          steps.status = { status: "pending_ambiguous", key: statusKey, reason: `状态流转后回读未确认（${current} → ${after || "?"}）` };
          errors.push(`状态流转后回读未确认（${current} → ${after || "?"}）`);
        }
      }
    } catch (error) {
      steps.status = { status: "pending_ambiguous", key: statusKey, reason: `状态流转失败: ${error.message}` };
      errors.push(`状态流转失败: ${error.message}`);
    }
  }

  const pending = Object.entries(steps)
    .filter(([, step]) => isUnsettledStep(step))
    .map(([name]) => name);
  const ok = pending.length === 0;
  return {
    schemaVersion: SAGA_SCHEMA_VERSION,
    ok,
    steps,
    pending,
    errors,
    ledger: nextLedger,
  };
}

export function isTbSyncPendingPhase(phase) {
  return phase === "sync_pending";
}
