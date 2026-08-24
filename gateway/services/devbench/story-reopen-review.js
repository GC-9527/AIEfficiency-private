import { createHash } from "node:crypto";

const SCOPE_VERSION = 1;
const REVIEW_DECISIONS = new Set(["correct", "corrected", "insufficient", "ticket_wrong"]);

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

function storyConfigurationFingerprint(tab = {}) {
  return digest({
    id: String(tab.id || ""),
    closedAt: Number(tab.closedAt || 0),
    groupId: String(tab.groupId || ""),
    groupClosedAt: Number(tab.groupClosedAt || 0),
    title: String(tab.title || ""),
    ticketUrl: String(tab.ticketUrl || ""),
    tbContext: tab.tbContext || null,
    projectDefId: String(tab.projectDefId || ""),
    mode: String(tab.mode || "local"),
    primaryProjectId: String(tab.primaryProjectId || ""),
    extraProjects: Array.isArray(tab.extraProjects) ? tab.extraProjects : [],
    flavors: Array.isArray(tab.flavors) ? tab.flavors : [],
    deviceSerial: String(tab.deviceSerial || ""),
    remotePull: tab.remotePull || null,
    worktree: tab.worktree || null,
    reportMode: String(tab.reportMode || ""),
    engine: String(tab.engine || ""),
    aiPrefs: tab.aiPrefs || null,
  });
}

function closedScopeMembers(closedTabs, anchorStoryId) {
  const storyId = String(anchorStoryId || "").trim();
  const rows = Array.isArray(closedTabs) ? closedTabs : [];
  const anchor = rows.find((row) => String(row?.id || "") === storyId);
  if (!anchor) return [];
  if (!anchor.groupId || !anchor.groupClosedAt) return [anchor];
  return rows.filter((row) => (
    String(row?.groupId || "") === String(anchor.groupId)
    && Number(row?.groupClosedAt || 0) === Number(anchor.groupClosedAt || 0)
  ));
}

function normalizedStoryIds(members) {
  return members.map((tab) => ({
    id: String(tab.id || ""),
    closedAt: Number(tab.closedAt || 0),
    groupId: String(tab.groupId || ""),
    groupClosedAt: Number(tab.groupClosedAt || 0),
    configFingerprint: storyConfigurationFingerprint(tab),
  })).sort((left, right) => left.id.localeCompare(right.id));
}

export function createStoryReopenReviewScope(closedTabs, anchorStoryId, {
  ownerId,
  trigger,
  now = Date.now(),
} = {}) {
  const anchorIds = [...new Set((Array.isArray(anchorStoryId) ? anchorStoryId : [anchorStoryId])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
  const anchorId = anchorIds[0] || "";
  const stableOwnerId = String(ownerId || "").trim();
  const stableTrigger = String(trigger || "").trim();
  if (!anchorId || !stableOwnerId || !stableTrigger) {
    return {
      ok: false,
      statusCode: 400,
      code: "STORY_REOPEN_SCOPE_INVALID",
      error: "重新打开故事点的推理必须绑定关闭故事点、稳定用户和入口 trigger",
    };
  }
  const memberMap = new Map();
  for (const currentAnchorId of anchorIds) {
    const scopedMembers = closedScopeMembers(closedTabs, currentAnchorId);
    if (!scopedMembers.length) {
      return {
        ok: false,
        statusCode: 409,
        code: "CLOSED_STORY_NOT_FOUND",
        error: `待复核的关闭故事点 ${currentAnchorId} 不存在或已经重新打开`,
      };
    }
    for (const member of scopedMembers) memberMap.set(String(member.id || ""), member);
  }
  const members = [...memberMap.values()];
  if (!members.length) {
    return {
      ok: false,
      statusCode: 409,
      code: "CLOSED_STORY_NOT_FOUND",
      error: "待复核的关闭故事点不存在或已经重新打开",
    };
  }
  const storyIds = normalizedStoryIds(members);
  const scopeFingerprint = digest({
    version: SCOPE_VERSION,
    consumer: "reopen_closed",
    trigger: stableTrigger,
    anchorStoryIds: anchorIds,
    storyIds,
  });
  return {
    ok: true,
    data: {
      version: SCOPE_VERSION,
      kind: "story_reopen",
      consumer: "reopen_closed",
      ownerId: stableOwnerId,
      trigger: stableTrigger,
      anchorStoryId: anchorId,
      anchorStoryIds: anchorIds,
      storyIds,
      scopeFingerprint,
      issuedAt: Number(now) || Date.now(),
    },
  };
}

function invalid(code, error, statusCode = 409) {
  return { ok: false, statusCode, code, error };
}

export function validateStoryReopenScope(scope, {
  closedTabs,
  activeTabs = [],
  storyId,
  ownerId,
  trigger,
  allowIdempotentReplay = false,
} = {}) {
  if (!scope || Number(scope.version) !== SCOPE_VERSION
    || scope.kind !== "story_reopen" || scope.consumer !== "reopen_closed") {
    return invalid("STORY_REOPEN_AI_REVIEW_REQUIRED", "本次推理没有服务端签发的故事点重开范围");
  }
  if (String(scope.ownerId || "") !== String(ownerId || "")) {
    return invalid("STORY_REOPEN_AI_REVIEW_OWNER_MISMATCH", "本次人工复核不属于当前登录用户", 403);
  }
  if (String(scope.trigger || "") !== String(trigger || "")) {
    return invalid("STORY_REOPEN_AI_REVIEW_TRIGGER_MISMATCH", "人工复核入口与本次重开入口不一致");
  }
  const requestedId = String(storyId || "").trim();
  const frozenIds = Array.isArray(scope.storyIds) ? scope.storyIds : [];
  if (!requestedId || !frozenIds.some((row) => String(row?.id || "") === requestedId)) {
    return invalid("STORY_REOPEN_AI_REVIEW_SCOPE_MISMATCH", "人工复核证明未绑定当前关闭故事点");
  }

  const closed = Array.isArray(closedTabs) ? closedTabs : [];
  const active = Array.isArray(activeTabs) ? activeTabs : [];
  let requestedActive = false;
  for (const frozen of frozenIds) {
    const frozenId = String(frozen?.id || "");
    const closedTab = closed.find((row) => String(row?.id || "") === frozenId);
    if (closedTab) {
      if (Number(closedTab.closedAt || 0) !== Number(frozen.closedAt || 0)
        || storyConfigurationFingerprint(closedTab) !== String(frozen.configFingerprint || "")) {
        return invalid(
          "STORY_REOPEN_AI_REVIEW_STALE",
          "人工复核后关闭故事点或整组配置已经变化，请基于当前配置重新推理并复核",
        );
      }
      if (frozen.groupId && frozen.groupClosedAt) {
        const currentGroupIds = closed.filter((row) => (
          String(row?.groupId || "") === String(frozen.groupId)
          && Number(row?.groupClosedAt || 0) === Number(frozen.groupClosedAt || 0)
        )).map((row) => String(row.id || ""));
        if (currentGroupIds.some((id) => !frozenIds.some((row) => String(row?.id || "") === id))) {
          return invalid("STORY_REOPEN_AI_REVIEW_STALE", "关闭故事点组成员已经变化，请重新推理并复核");
        }
      }
      continue;
    }
    const activeTab = active.find((row) => String(row?.id || "") === frozenId);
    if (!allowIdempotentReplay || !activeTab
      || Number(activeTab.lastClosedAt || 0) !== Number(frozen.closedAt || 0)) {
      return invalid(
        "STORY_REOPEN_AI_REVIEW_STALE",
        "人工复核后关闭故事点或整组配置已经变化，请基于当前配置重新推理并复核",
      );
    }
    if (frozenId === requestedId) requestedActive = true;
  }
  return { ok: true, scope, ...(requestedActive ? { idempotent: true } : {}) };
}

export function validateStoryReopenReviewRun(run, {
  closedTabs,
  activeTabs = [],
  storyId,
  ownerId,
  now = Date.now(),
  ttlMs,
  allowIdempotentReplay = false,
} = {}) {
  if (!run?.reopenScope) {
    return invalid("STORY_REOPEN_AI_REVIEW_REQUIRED", "配置推理记录没有绑定故事点重开范围");
  }
  if (String(run.trigger || "") !== String(run.reopenScope.trigger || "")) {
    return invalid("STORY_REOPEN_AI_REVIEW_TRIGGER_MISMATCH", "配置推理记录的入口绑定已损坏");
  }
  const review = run.review;
  if (!review || !REVIEW_DECISIONS.has(String(review.decision || ""))) {
    return invalid("STORY_REOPEN_AI_REVIEW_REQUIRED", "请先完成人工复核；暂不采用或信息不足也需要保存复核结论");
  }
  if (String(review.reviewer || "") !== String(ownerId || "")
    || String(run.reopenScope.ownerId || "") !== String(ownerId || "")) {
    return invalid("STORY_REOPEN_AI_REVIEW_OWNER_MISMATCH", "本次人工复核不属于当前登录用户", 403);
  }
  const reviewedAt = Number(review.reviewedAt || 0);
  const effectiveTtl = Math.max(1, Number(ttlMs) || 1);
  if (!reviewedAt || reviewedAt < Number(run.reopenScope.issuedAt || 0)
    || Number(now) - reviewedAt > effectiveTtl) {
    return invalid("STORY_REOPEN_AI_REVIEW_EXPIRED", "人工复核证明已过期，请重新推理并复核");
  }
  if (run.stalePrediction === true) {
    return invalid("STORY_REOPEN_AI_REVIEW_STALE", "推理规则或配置已经变化，请重新推理并复核");
  }
  return validateStoryReopenScope(run.reopenScope, {
    closedTabs,
    activeTabs,
    storyId,
    ownerId,
    trigger: run.trigger,
    allowIdempotentReplay,
  });
}
