const OBJECT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const IMPACT_DIGEST = /^[0-9a-f]{64}$/i;

export const REMOTE_REWRITE_RELATIONSHIPS = Object.freeze([
  "REMOTE_REWIND",
  "DIVERGED_FROM_ACCEPTED",
]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function displayValue(value) {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return { items: [], valid: false };
  return {
    items: value.map(displayValue),
    valid: value.every((item) => typeof item === "string"),
  };
}

function normalizeAffectedStories(value) {
  if (!Array.isArray(value)) return { items: [], valid: false };
  return {
    items: value.map((item) => ({
      storyId: text(item?.storyId) || displayValue(item?.storyId),
      baseRevision: text(item?.baseRevision) || displayValue(item?.baseRevision),
    })),
    valid: value.every((item) => (
      item
      && typeof item === "object"
      && !Array.isArray(item)
      && !!text(item.storyId)
      && OBJECT_SHA.test(text(item.baseRevision))
    )),
  };
}

export function isRemoteHistoryRewritePreview(preview = {}) {
  return REMOTE_REWRITE_RELATIONSHIPS.includes(text(preview?.relationship));
}

export function remoteRewriteImpactView(preview = {}) {
  const raw = preview?.rewriteImpact;
  const impact = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const dropped = normalizeStringList(impact.droppedCommits);
  const affected = normalizeAffectedStories(impact.affectedStories);
  const published = normalizeStringList(impact.publishedCommits);
  const previousSha = text(impact.previousSha);
  const candidateSha = text(impact.candidateSha);
  const publishedCommitStatus = text(impact.publishedCommitStatus) || "UNKNOWN";
  const publicationEvidenceId = text(impact.publicationEvidenceId);
  const publicationEvidenceDigest = text(impact.publicationEvidenceDigest);
  const digest = text(impact.digest);
  const droppedCommitCount = impact.droppedCommitCount;
  const droppedCountValid = Number.isSafeInteger(droppedCommitCount)
    && droppedCommitCount >= 0
    && droppedCommitCount >= dropped.items.length
    && (impact.droppedCommitsTruncated === true || droppedCommitCount === dropped.items.length);
  const previewPreviousSha = text(preview?.lastAcceptedSha || preview?.expectedAcceptedSha);
  const previewCandidateSha = text(preview?.candidateSha);
  const contractErrors = [];

  if (!raw || impact.version !== 1) {
    contractErrors.push("远端改写影响预览缺失或版本不受支持");
  }
  if (!OBJECT_SHA.test(previousSha) || !OBJECT_SHA.test(candidateSha)) {
    contractErrors.push("影响预览未返回完整的 40/64 位旧 SHA 和新 SHA");
  }
  if (
    (previewPreviousSha && previousSha !== previewPreviousSha)
    || (previewCandidateSha && candidateSha !== previewCandidateSha)
  ) {
    contractErrors.push("影响预览 SHA 与当前远端刷新预览不一致");
  }
  if (
    !droppedCountValid
    || !dropped.valid
    || typeof impact.droppedCommitsTruncated !== "boolean"
  ) {
    contractErrors.push("丢失提交计数或返回列表不完整");
  }
  if (!affected.valid || typeof impact.affectedStoriesTruncated !== "boolean") {
    contractErrors.push("受影响故事列表不完整");
  }
  if (
    !["NONE", "PRESENT", "UNKNOWN"].includes(publishedCommitStatus)
    || !published.valid
    || typeof impact.publishedCommitsTruncated !== "boolean"
  ) {
    contractErrors.push("发布提交状态或返回列表不完整");
  }
  if (
    publishedCommitStatus !== "UNKNOWN"
    && (!publicationEvidenceId || !IMPACT_DIGEST.test(publicationEvidenceDigest))
  ) {
    contractErrors.push("权威发布证据来源或 digest 缺失");
  }
  if (typeof impact.approvalAllowed !== "boolean") {
    contractErrors.push("影响预览未声明是否允许批准");
  }
  if (!IMPACT_DIGEST.test(digest)) {
    contractErrors.push("影响预览 digest 缺失或无效");
  }

  const approvalBlockers = [...contractErrors];
  if (publishedCommitStatus === "UNKNOWN") {
    approvalBlockers.push("发布提交状态为 UNKNOWN，安全策略禁止管理员批准");
  }
  if (
    impact.droppedCommitsTruncated === true
    || impact.affectedStoriesTruncated === true
    || impact.publishedCommitsTruncated === true
  ) {
    approvalBlockers.push("影响列表已截断，必须取得完整影响预览后才能批准");
  }
  if (impact.approvalAllowed !== true) {
    approvalBlockers.push("Controller 已将本次影响标记为不可批准");
  }

  return {
    version: impact.version,
    previousSha,
    candidateSha,
    droppedCommitCount,
    droppedCommits: dropped.items,
    droppedCommitsTruncated: impact.droppedCommitsTruncated === true,
    affectedStories: affected.items,
    affectedStoriesTruncated: impact.affectedStoriesTruncated === true,
    publishedCommitStatus,
    publishedCommits: published.items,
    publishedCommitsTruncated: impact.publishedCommitsTruncated === true,
    publicationEvidenceId,
    publicationEvidenceDigest,
    approvalAllowed: (
      isRemoteHistoryRewritePreview(preview)
      && approvalBlockers.length === 0
    ),
    backendApprovalAllowed: impact.approvalAllowed === true,
    digest,
    contractErrors,
    approvalBlockers,
  };
}

function appendReturnedList(lines, title, items, truncated, formatter = (item) => item) {
  lines.push(`${title}返回列表：${items.length} 项；${truncated ? "已截断" : "未截断"}`);
  if (items.length === 0) {
    lines.push("- （无返回项）");
    return;
  }
  for (const item of items) lines.push(`- ${formatter(item)}`);
}

export function buildRemoteRewriteConfirmation(preview = {}) {
  const impact = remoteRewriteImpactView(preview);
  const lines = [
    "确认仅批准本次远端历史改写？",
    `关系：${text(preview?.relationship) || "UNKNOWN"}`,
    `旧 SHA（完整）：${impact.previousSha || "未返回"}`,
    `新 SHA（完整）：${impact.candidateSha || "未返回"}`,
    `丢失提交总数：${
      Number.isSafeInteger(impact.droppedCommitCount) ? impact.droppedCommitCount : "未返回"
    }`,
  ];
  appendReturnedList(
    lines,
    "丢失提交",
    impact.droppedCommits,
    impact.droppedCommitsTruncated,
  );
  appendReturnedList(
    lines,
    "受影响故事",
    impact.affectedStories,
    impact.affectedStoriesTruncated,
    (item) => `${item.storyId || "未返回 storyId"} | baseRevision=${item.baseRevision || "未返回"}`,
  );
  lines.push(
    `发布提交状态：${impact.publishedCommitStatus}${
      impact.publishedCommitStatus === "UNKNOWN" ? "（阻断批准）" : ""
    }`,
    `发布证据来源：${impact.publicationEvidenceId || "未返回"}`,
    `发布证据 digest：${impact.publicationEvidenceDigest || "未返回"}`,
  );
  if (impact.publishedCommitStatus === "PRESENT") {
    lines.push("发布证据语义：下列 SHA 是受保护证据的精确正命中，不代表当前已发布提交全集");
  }
  appendReturnedList(
    lines,
    "发布提交",
    impact.publishedCommits,
    impact.publishedCommitsTruncated,
  );
  lines.push(`影响摘要 digest：${impact.digest || "未返回"}`);
  return lines.join("\n");
}
