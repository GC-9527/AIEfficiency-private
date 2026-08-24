const text = (value) => String(value ?? "").trim();

/** 只有用户显式开启时才运行故事点 AI 推理；未保存过该设置时默认关闭。 */
export function isStoryPointAiInferenceEnabled(config = {}) {
  return config?.storyPointAiInferenceEnabled === true;
}

/** 复核必须优先使用 run 自身所属项目，避免切换当前 TB 项目后把反馈写错项目。 */
export function resolveInferenceProjectId(session = {}, pendingProjectId = "", currentProjectId = "") {
  return text(session?.projectId || session?.ticket?.projectId || pendingProjectId || currentProjectId);
}

export function resolveStoryInferenceProjectId({ projectId = "", deferredKind = "", tabId = "" } = {}) {
  const explicit = text(projectId);
  if (explicit) return explicit;
  const storyId = text(tabId);
  if (storyId) return `story:${storyId}`;
  const kind = text(deferredKind) || "manual";
  return `story-entry:${kind}`;
}

export function reopenReviewedConfigPartialResult(reopenResult = {}, {
  tabId = "",
  recoveredTab = null,
} = {}) {
  const recoveryTabId = text(tabId || reopenResult?.data?.id);
  const label = text(recoveredTab?.title || recoveryTabId) || "未知故事点";
  return {
    ...reopenResult,
    ok: false,
    partial: true,
    code: "STORY_REOPEN_REVIEWED_CONFIG_APPLY_FAILED",
    error: recoveredTab
      ? `故事点记录「${label}」已恢复到活动列表，但 AI 复核配置未能应用；请打开故事点配置人工核对，工作流未启动`
      : `故事点记录已恢复（${label}），但 AI 复核配置未能应用且活动列表暂未定位；请刷新后人工核对，工作流未启动`,
    tabId: recoveryTabId,
    recoveryTabFound: !!recoveredTab,
  };
}

/**
 * 已有故事点的再次开发仍先复核；需要新建故事点的入口先打开初始化面板，
 * 由面板并发运行 AI 推理，不能再让独立推理页挡在创建面板之前。
 */
export function shouldDeferStoryEntry({ enabled = true, kind = "task", task = null, items = [] } = {}) {
  if (enabled === false) return false;
  if (kind === "task_group") {
    return Array.isArray(items) && items.length > 1 && items.every((item) => !!text(item?.tabId));
  }
  return kind === "task" && !!text(task?.tabId);
}

export function isDeferredTaskStoryEntry(pending = null) {
  return pending?.deferredEntry?.kind === "task" && !!pending.deferredEntry.task;
}

export function isDeferredTaskGroupStoryEntry(pending = null) {
  return pending?.deferredEntry?.kind === "task_group"
    && Array.isArray(pending.deferredEntry.items)
    && pending.deferredEntry.items.length > 1;
}

export function isDeferredGitCommitStoryEntry(pending = null) {
  return pending?.deferredEntry?.kind === "git_commit"
    && !!pending.deferredEntry.body
    && !!pending?.session?.id;
}

export function isDeferredStoryInitializationEntry(pending = null) {
  return pending?.deferredEntry?.kind === "story_initialization"
    && !!pending.deferredEntry.body;
}

export function isDeferredStoryInitializationPanelEntry(pending = null) {
  return pending?.deferredEntry?.kind === "story_initialization_panel"
    && !!pending.deferredEntry.flowId;
}

export function isDeferredStoryReopenEntry(pending = null) {
  return pending?.deferredEntry?.kind === "story_reopen"
    && !!pending.deferredEntry.storyId;
}

export function isDeferredTeamDevStoryEntry(pending = null) {
  return pending?.deferredEntry?.kind === "team_dev"
    && !!pending.deferredEntry.task
    && !!pending.deferredEntry.source;
}

/**
 * 通用用户入口在人工复核结束后必须恢复原业务动作。Git commit 由独立 dispatcher
 * 恢复同一个初始化面板，因此不放入这个通用集合。
 */
export function shouldContinueDeferredStoryEntry(pending = null) {
  return isDeferredTaskStoryEntry(pending)
    || isDeferredTaskGroupStoryEntry(pending)
    || isDeferredStoryInitializationEntry(pending)
    || isDeferredStoryReopenEntry(pending)
    || isDeferredTeamDevStoryEntry(pending);
}

export function taskStoryCreateEntry(task = null) {
  const taskId = text(task?.id);
  const tbTaskId = text(task?.tbTaskId);
  const ticketUrl = text(task?.ticketUrl);
  const ticketId = text(task?.ticketId || task?.carbId);
  const carbId = text(task?.carbId);
  const title = text(task?.storyTitle || task?.title);
  if (!taskId && !tbTaskId && !title) return null;
  return {
    kind: "task_story",
    ...(taskId ? { taskId } : {}),
    ...(tbTaskId ? { tbTaskId } : {}),
    ...(ticketUrl ? { ticketUrl } : {}),
    ...(ticketId ? { ticketId } : {}),
    ...(carbId ? { carbId } : {}),
    ...(title ? { title } : {}),
  };
}

function taskTicketMatches(task = null, currentTicket = "") {
  const ticket = text(currentTicket);
  if (!ticket) return false;
  const candidates = [task?.ticketUrl, task?.ticketId, task?.tbTaskId, task?.carbId]
    .map(text)
    .filter(Boolean);
  if (candidates.includes(ticket)) return true;
  const ticketTbTaskId = ticket.match(/(?:^|\/)task\/([0-9a-f]{24})(?:$|[/?#])/i)?.[1]
    || ticket.match(/^[0-9a-f]{24}$/i)?.[0]
    || "";
  if (ticketTbTaskId && ticketTbTaskId.toLowerCase() === text(task?.tbTaskId).toLowerCase()) return true;
  const ticketCarbId = ticket.match(/\bCARB-\d+\b/i)?.[0]?.toUpperCase() || "";
  return !!ticketCarbId && ticketCarbId === text(task?.carbId).toUpperCase();
}

/**
 * 初始化面板改绑 TB 时，先用服务端解析结果替换旧任务的 TB 身份和项目域。
 * 本地待办 id 与已冻结的故事点标题仍属于当前入口，不能被 TB payload 覆盖；
 * 旧工单的详情、评论和附件也不能混入新工单的推理证据。
 */
export async function resolveTaskStoryInferenceTask(task = null, {
  currentTicket = "",
  storyTitle = "",
  resolveTbTask = null,
} = {}) {
  if (!task) return { ok: true, changed: false, task: null };
  const ticket = text(currentTicket);
  if (taskTicketMatches(task, ticket)) return { ok: true, changed: false, task };

  const clearedEvidence = {
    description: "",
    note: "",
    comments: [],
    attachments: [],
    tags: [],
    sourceCoverage: {},
  };
  if (!ticket) {
    return {
      ok: true,
      changed: true,
      task: {
        ...task,
        ...clearedEvidence,
        storyTitle: text(storyTitle || task.storyTitle || task.title),
        title: text(storyTitle || task.storyTitle || task.title),
        ticketUrl: "",
        ticketId: "",
        tbTaskId: "",
        carbId: "",
      },
    };
  }
  if (typeof resolveTbTask !== "function") {
    return { ok: false, changed: true, error: "缺少 TB 单解析能力，无法按当前绑定重新推理" };
  }

  let resolved;
  try {
    resolved = await resolveTbTask(ticket);
  } catch (error) {
    return { ok: false, changed: true, error: error?.message || "读取新 TB 单失败" };
  }
  if (!resolved?.ok || !resolved.data) {
    return { ok: false, changed: true, error: resolved?.error || "无法识别当前 TB 单" };
  }
  const next = resolved.data;
  const projectId = text(next.projectId);
  const tbTaskId = text(next.tbTaskId);
  if (!projectId || !tbTaskId) {
    return {
      ok: false,
      changed: true,
      error: !projectId ? "新 TB 单缺少真实项目，无法建立隔离推理域" : "新 TB 单缺少稳定任务 ID，无法绑定创建证明",
    };
  }
  const localTaskId = text(task.id);
  return {
    ok: true,
    changed: true,
    task: {
      ...task,
      ...next,
      ...clearedEvidence,
      ...(localTaskId ? { id: localTaskId } : {}),
      storyTitle: text(storyTitle || task.storyTitle || task.title),
      ticketUrl: text(next.ticketUrl) || `https://www.teambition.com/task/${tbTaskId}`,
      ticketId: tbTaskId,
      tbTaskId,
      carbId: text(next.carbId).toUpperCase(),
      projectId,
    },
  };
}

function initializationCreateEntry(entry = {}) {
  const body = entry?.body && typeof entry.body === "object" ? entry.body : {};
  const identity = entry?.entry && typeof entry.entry === "object" ? entry.entry : {};
  if (identity.kind === "git_commit") {
    return gitCommitCreateEntry({
      body: {
        ...identity,
        title: body.title,
      },
    });
  }
  if (entry?.task) return taskStoryCreateEntry(entry.task);
  const copyFromId = text(identity.copyFromId || body.copyFromId);
  const copyFromKind = text(identity.copyFromKind || body.copyFromKind);
  const title = text(body.title);
  if (!title) return null;
  return copyFromId
    ? {
      kind: "story_copy",
      title,
      copyFromId,
      ...(copyFromKind ? { copyFromKind } : {}),
    }
    : { kind: "blank_story", title };
}

function gitCommitCreateEntry(entry = {}) {
  const body = entry?.body && typeof entry.body === "object" ? entry.body : {};
  const commit = entry?.preview?.commit && typeof entry.preview.commit === "object"
    ? entry.preview.commit
    : {};
  const repositoryId = text(body.repositoryId);
  const revision = text(commit.revision || body.revision);
  if (!repositoryId || !revision) return null;
  const title = text(body.title || commit.subject);
  return {
    kind: "git_commit",
    repositoryId,
    revision,
    ...(title ? { title } : {}),
  };
}

/**
 * 任务没有稳定 tabId 时，业务续跑会按 TB 单、CARB 单号或精确标题恢复历史故事点。
 * 推理前必须使用同一套唯一匹配规则冻结目标；多条命中时不猜测，由服务端拒绝并让用户刷新/定夺。
 */
export function resolveClosedStoryIdForTask(task = null, closedStories = []) {
  const stableTabId = text(task?.tabId);
  if (stableTabId) return stableTabId;
  const rows = Array.isArray(closedStories) ? closedStories : [];
  const ticketUrl = text(task?.ticketUrl);
  const carbId = text(task?.carbId).toUpperCase();
  const title = text(task?.title);
  const matches = rows.filter((row) => {
    const rowTicket = text(row?.ticketUrl);
    const rowTitle = text(row?.title);
    if (ticketUrl && rowTicket === ticketUrl) return true;
    if (carbId && new RegExp(`#${carbId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#`, "i").test(rowTitle)) return true;
    return !!title && rowTitle === title;
  });
  return matches.length === 1 ? text(matches[0]?.id) : "";
}

/**
 * 冻结一次用户入口可能恢复的关闭故事点。服务端会再按 closedAt/组成员展开并校验，
 * 前端只提交稳定 ID；当前已打开的 Tab 不需要重开证明。
 */
export function configInferenceStoryEntryScope(deferredEntry = null, {
  openStoryIds = [],
  closedStories = [],
} = {}) {
  const entry = deferredEntry && typeof deferredEntry === "object" ? deferredEntry : {};
  const open = new Set((Array.isArray(openStoryIds) ? openStoryIds : []).map(text).filter(Boolean));
  let candidates = [];
  let createEntries = [];
  if (entry.kind === "story_reopen") {
    candidates = [entry.storyId];
  } else if (entry.kind === "task") {
    candidates = [resolveClosedStoryIdForTask(entry.task, closedStories)];
    createEntries = [taskStoryCreateEntry(entry.task)];
  } else if (entry.kind === "task_group") {
    candidates = (Array.isArray(entry.items) ? entry.items : [])
      .map((item) => resolveClosedStoryIdForTask(item, closedStories));
    createEntries = (Array.isArray(entry.items) ? entry.items : [])
      .map((item) => taskStoryCreateEntry(item));
  } else if (entry.kind === "team_dev") {
    candidates = [
      resolveClosedStoryIdForTask(entry.task, closedStories),
      entry.source?.closed ? entry.source?.id : "",
    ];
    createEntries = [taskStoryCreateEntry(entry.task)];
  } else if (entry.kind === "story_initialization" || entry.kind === "story_initialization_panel") {
    createEntries = [initializationCreateEntry(entry)];
  } else if (entry.kind === "git_commit") {
    createEntries = [gitCommitCreateEntry(entry)];
  }
  const storyIds = [...new Set(candidates.map(text).filter((id) => id && !open.has(id)))];
  const uniqueCreateEntries = [];
  const createKeys = new Set();
  for (const createEntry of createEntries.filter(Boolean)) {
    const key = JSON.stringify(createEntry);
    if (createKeys.has(key)) continue;
    createKeys.add(key);
    uniqueCreateEntries.push(createEntry);
  }
  if (!storyIds.length && !uniqueCreateEntries.length) return null;
  return {
    kind: text(entry.kind),
    ...(storyIds.length ? { storyIds } : {}),
    ...(uniqueCreateEntries.length ? { createEntries: uniqueCreateEntries } : {}),
  };
}

/** 服务端签发了重开范围时，复核记录本身就是后续 /tabs/reopen-closed 的授权证明。 */
export function requiresSavedStoryReopenReview(pending = null) {
  const scope = pending?.session?.reopenScope;
  return scope?.consumer === "reopen_closed"
    && Array.isArray(scope.storyIds)
    && scope.storyIds.length > 0;
}

/**
 * 仍需服务端 AI 证明的后台入口。故事点初始化已改为“当前草稿人工确认 + AI 异步建议”，
 * 不得再把 inference review 当作创建授权门禁。
 */
export function requiresSavedStoryCreationReview(pending = null) {
  const scope = pending?.session?.createScope;
  if (Array.isArray(scope?.entries) && scope.entries.length > 0
    && !isDeferredStoryInitializationEntry(pending)
    && !isDeferredStoryInitializationPanelEntry(pending)) return true;
  return [
    "task",
    "task_group",
    "team_dev",
    "git_commit",
  ].includes(text(pending?.deferredEntry?.kind));
}

export function configInferenceReopenReviewProof(pending = null, projectId = "") {
  if (!requiresSavedStoryReopenReview(pending)) return null;
  const configInferenceRunId = text(pending?.session?.id);
  const stableProjectId = resolveInferenceProjectId(pending?.session, projectId, "");
  return configInferenceRunId && stableProjectId
    ? { projectId: stableProjectId, configInferenceRunId }
    : null;
}

/**
 * 用户主动触发的入口在确认后即结束本次推理页，不能被反馈接口或后续故事点操作占住弹窗。
 * 后台 group_auto 属于强制门禁，仍需等服务端确认成功后才能关闭。
 */
export function shouldDismissConfigInferenceBeforeReview(pending = null) {
  if (pending?.continueAction === "group_auto") return false;
  if (requiresSavedStoryReopenReview(pending)) return false;
  if (isDeferredStoryInitializationPanelEntry(pending)) return true;
  if (requiresSavedStoryCreationReview(pending)) return false;
  return pending?.dismissOnConfirm === true
    || shouldContinueDeferredStoryEntry(pending);
}

/**
 * 初始化面板里的“暂不采用”立即退出推理展示层；反馈保存是 best-effort，
 * 与当前草稿的编辑和最终创建完全解耦。
 */
export function shouldDismissStoryInitializationSkipBeforeReview(pending = null, payload = null) {
  if (pending?.continueAction === "group_auto") return false;
  return isDeferredStoryInitializationPanelEntry(pending)
    && payload?.decision === "insufficient"
    && payload?.apply === false;
}

/**
 * 用户主动入口已经把“确认并继续”视为本次推理页的终态：即使反馈保存失败，
 * 也继续故事点流程，并在有服务端确认快照时照常应用；不能再把同一个 run 弹回来。
 * 后台 group_auto 仍是强制门禁，失败时保持当前弹窗且不得继续。
 */
export function configInferenceReviewFailurePolicy(pending = null) {
  return shouldDismissConfigInferenceBeforeReview(pending)
    ? "continue_without_reopen"
    : "keep_current_modal";
}

/**
 * “推理正确”的确认配置在 run 创建时已经由服务端校验并物化为 suggestedSnapshot。
 * 复核接口只负责保存反馈/训练记录；它失败时不能把用户已经确认的工程配置一起丢掉。
 *
 * corrected 不能复用旧 suggestedSnapshot（它可能已被用户改过）；信息不足、工单错误
 * 和“暂不采用”也都没有可应用的确认快照。
 */
export function confirmedConfigInferenceSnapshot(session = {}, payload = {}) {
  if (payload?.apply !== true || payload?.decision !== "correct") return null;
  const localBindings = Array.isArray(payload?.localProjectBindings) ? payload.localProjectBindings : [];
  // 浏览器拿不到本机工程绝对路径，不能把人工本机选择合并进 run 创建时的旧远程快照。
  // 业务失败时由服务端 confirmedSnapshot 完成这件事；网络中断时宁可不应用，也不能退回远程。
  if (localBindings.some((binding) => String(binding?.projectId || "").trim())) return null;
  const snapshot = session?.suggestedSnapshot;
  return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot
    : null;
}

/**
 * 复核成功后，服务端 snapshot 是唯一可信的应用结果；null 可能表示整组仍含代号，
 * 不能再回退到旧 suggestedSnapshot。复核失败时则优先使用服务端根据本机绑定预览的
 * confirmedSnapshot，最后才使用无需人工本机绑定的浏览器冻结快照。
 */
export function configInferenceSnapshotForReviewResult(result = {}, payload = {}, clientFallback = null) {
  if (payload?.apply !== true) return null;
  if (result?.ok === true) return result?.snapshot || null;
  return result?.confirmedSnapshot || clientFallback || null;
}

/**
 * 自动恢复只负责断线/刷新后真正遗漏的 group_auto 复核，不能把用户刚提交、
 * 正在后台创建故事点或已降级续跑的 run 再次弹出。
 */
export function createConfigInferencePresentationGuard(limit = 100) {
  const suppressed = new Set();
  const maxSize = Math.max(1, Number(limit) || 100);
  const key = (runId) => text(runId);
  return {
    suppress(runId) {
      const id = key(runId);
      if (!id) return false;
      suppressed.add(id);
      while (suppressed.size > maxSize) suppressed.delete(suppressed.values().next().value);
      return true;
    },
    isSuppressed(runId) {
      const id = key(runId);
      return !!id && suppressed.has(id);
    },
    shouldPresent({ currentSuggest = null, storyEntryInFlight = false, runId = "" } = {}) {
      const id = key(runId);
      return !currentSuggest && !storyEntryInFlight && !!id && !suppressed.has(id);
    },
  };
}

/**
 * 配置复核提交必须在 React state 刷新前同步互斥。仅依赖 busy state 时，
 * 同一事件循环里的重复 click 会同时进入异步提交，并重复执行复核或后续流程。
 */
export function createConfigInferenceSubmissionGuard() {
  let sequence = 0;
  let active = null;
  const key = (runId) => text(runId);
  return {
    acquire(runId) {
      const id = key(runId);
      if (!id || active) return "";
      const token = `${id}:${sequence += 1}`;
      active = { token, runId: id };
      return token;
    },
    release(token) {
      if (!active || active.token !== text(token)) return false;
      active = null;
      return true;
    },
    current() {
      return active ? { ...active } : null;
    },
  };
}

/**
 * 用户入口共用一个互斥槽：从发起推理一直持有到复核续跑结束。
 * token 校验可防止旧请求的 finally 误释放后发请求持有的锁。
 */
export function createStoryEntryInFlightGuard() {
  let activeToken = "";
  return {
    acquire(token) {
      const next = text(token) || "story-entry";
      if (activeToken) return false;
      activeToken = next;
      return true;
    },
    release(token) {
      const expected = text(token);
      if (!activeToken || (expected && expected !== activeToken)) return false;
      activeToken = "";
      return true;
    },
    current() {
      return activeToken;
    },
  };
}

/** 发生资源占用时用户在冲突窗口的选择优先，AI 快照不再自动套用。 */
export function shouldSkipReviewedSnapshotForConflict(reviewedSnapshot) {
  return !!reviewedSnapshot;
}
