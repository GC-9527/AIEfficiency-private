export const WORKTREE_CLEANUP_CHECKS = [
  {
    key: "dirty",
    label: "本地改动",
    safeText: "工作区干净",
    blockedText: (count) => `${count} 个文件未提交`,
    help: "请先提交、还原或移走本地改动。",
  },
  {
    key: "unpushed",
    label: "未推送提交",
    safeText: "没有仅本地提交",
    blockedText: (count) => `${count} 个提交未推送`,
    help: "请先 Push 到远程仓库，确认远端已保存。",
  },
  {
    key: "stashes",
    label: "未恢复 stash",
    safeText: "没有待恢复 stash",
    blockedText: (count) => `${count} 个 stash 未处理`,
    help: "请先恢复或明确删除属于当前故事点分支的 stash。",
  },
];

export function worktreeMutationEntryDisabled(state = {}) {
  // runningTaskId is persisted display state and can survive a crashed Gateway.
  // The backend lease/process inspection remains authoritative for every mutation.
  return state.liveRunning === true;
}

export function worktreeCleanupCards(inspection) {
  const totals = inspection?.totals || {};
  return WORKTREE_CLEANUP_CHECKS.map((check) => {
    const count = Number(totals[check.key] || 0);
    return {
      ...check,
      count,
      safe: count === 0,
      statusText: count === 0 ? check.safeText : check.blockedText(count),
    };
  });
}

export function worktreeCleanupCanConfirm(inspection, acknowledged) {
  return !!inspection?.available
    && inspection?.safe === true
    && !!inspection?.token
    && acknowledged === true;
}

/** 后端仍校验该确认词；前端在延迟解锁后自动附带，用户无需手输。 */
export const WORKTREE_FORCE_CONFIRMATION = "强制删除";

/** 强制删除确认按钮解锁等待时长（毫秒）。 */
export const WORKTREE_FORCE_UNLOCK_MS = 2000;

export function worktreeCleanupForceStatus(inspection) {
  if (!inspection?.available) {
    return {
      kind: "unavailable",
      blocked: false,
      blockers: [],
    };
  }
  if (typeof inspection.forceAllowed !== "boolean") {
    return {
      kind: "gateway_capability_missing",
      blocked: true,
      blockers: [],
    };
  }
  if (inspection.forceAllowed === true) {
    return {
      kind: "allowed",
      blocked: false,
      blockers: [],
    };
  }
  return {
    kind: "blocked",
    blocked: true,
    blockers: Array.isArray(inspection.blockers) ? inspection.blockers : [],
  };
}

/**
 * @param {object} inspection
 * @param {boolean} acknowledged 勾选风险确认
 * @param {boolean} unlocked 延迟倒计时结束
 */
export function worktreeCleanupCanForce(inspection, acknowledged, unlocked) {
  const hasRunningTask = (inspection?.blockers || []).some((blocker) => blocker?.type === "running_task");
  return !!inspection?.available
    && !!inspection?.token
    && inspection?.forceAllowed === true
    && !hasRunningTask
    && acknowledged === true
    && unlocked === true;
}

export function worktreeCleanupBlockerHelp(blocker) {
  const type = String(blocker?.type || "");
  if (type === "dirty") return "提交、还原或移走这些文件后重新检查。";
  if (type === "unpushed") return "Push 到远程并刷新远端引用后重新检查。";
  if (type === "stash") return "恢复或删除对应 stash 后重新检查。";
  if (type === "running_task") return "等待当前 AI 任务结束，或先安全停止任务。";
  return "请根据错误信息修复 Git 状态后重新检查。";
}

/** 从受管 worktree entries 取主工程真实 checkout 路径（供横幅展示）。 */
export function storyWorktreeDisplayPath(tab) {
  const entries = Array.isArray(tab?.worktree?.entries) ? tab.worktree.entries : [];
  const primary = entries.find((entry) => entry?.role === "primary" && entry.active !== false)
    || entries.find((entry) => entry?.role !== "inactive" && entry?.role !== "webapp");
  const target = String(primary?.path || primary?.worktreePath || "").trim();
  if (target) {
    return {
      path: target,
      branch: String(primary?.branch || "").trim(),
      name: String(primary?.name || "").trim(),
      root: String(tab?.worktree?.root || "").trim(),
    };
  }
  const root = String(tab?.worktree?.root || "").trim();
  return { path: root, branch: "", name: "", root };
}
