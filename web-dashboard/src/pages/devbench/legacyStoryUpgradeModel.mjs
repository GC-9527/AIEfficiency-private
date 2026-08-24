export const LEGACY_STORY_ATTESTATION_CODE = "STORY_REPOSITORY_ATTESTATION_REQUIRED";

const CONTROLLER_SETUP_CODES = new Set([
  "GIT_CONTROLLER_CLIENT_CONFIG_REQUIRED",
  "GIT_CONTROLLER_PROCESS_REQUIRED",
  "GIT_CONTROLLER_UNAVAILABLE",
]);

function activeEntries(tab) {
  return (Array.isArray(tab?.worktree?.entries) ? tab.worktree.entries : [])
    .filter((entry) => entry?.active !== false && String(entry?.role || "") !== "inactive");
}

export function hasCompleteStoryRepositoryGrant(tab) {
  const entries = activeEntries(tab);
  return (
    String(tab?.worktree?.repositoryMode || "") === "INDEPENDENT_REPOSITORY"
    && entries.length > 0
    && entries.every((entry) => (
      String(entry?.repositoryMode || "") === "INDEPENDENT_REPOSITORY"
      && String(entry?.controllerRepositoryId || entry?.repositoryId || "").trim()
      && String(entry?.workerIdentity || "").trim()
      && /^[0-9a-f]{64}$/i.test(String(entry?.storyAclFingerprint || ""))
      && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(String(entry?.baseRevision || ""))
      && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(String(entry?.headRevision || ""))
    ))
  );
}

export function needsLegacyStoryUpgrade(tab) {
  return (
    String(tab?.mode || "local") === "local"
    && !!String(tab?.primaryProjectId || "").trim()
    && !hasCompleteStoryRepositoryGrant(tab)
  );
}

export function legacyUpgradeSummary(preview = {}) {
  const summary = preview?.summary || {};
  return {
    projectCount: Number(summary.projectCount || 0),
    snapshotCount: Number(summary.snapshotCount || 0),
    changedFileCount: Number(summary.changedFileCount || 0),
    untrackedCount: Number(summary.untrackedCount || 0),
    blocked: preview?.canUpgrade !== true,
    blockerCount: Array.isArray(preview?.blockers) ? preview.blockers.length : 0,
  };
}

function blockerGuide(blocker) {
  const code = String(blocker?.code || "STORY_REPOSITORY_LEGACY_UPGRADE_BLOCKED");
  const message = String(blocker?.message || "当前条件尚未满足");
  if (CONTROLLER_SETUP_CODES.has(code)) {
    return {
      key: "controller",
      code,
      title: "启动独立 Git Controller",
      detail: "请由部署管理员启动受保护的 Git Controller 服务，并确认 Gateway 已加载固定客户端信任配置。页面不会用 Gateway 进程冒充 Controller。",
    };
  }
  if (code === "STORY_REPOSITORY_WORKER_IDENTITY_MISSING") {
    return {
      key: "worker",
      code,
      title: "配置当前故事点的受限 Worker 身份",
      detail: "为这个故事点部署独立 Worker 身份并完成真实跨身份权限探测；手工填写身份或 ACL 字段不会被当作有效证明。",
    };
  }
  if (code === "STORY_REPOSITORY_DEFINITION_REQUIRED") {
    return {
      key: "definition",
      code,
      title: "补齐可升级工程定义",
      detail: "重新打开工程配置，确认主工程与关联工程仍指向可访问的基础仓库。",
    };
  }
  if (code === "STORY_AI_RUNNING") {
    return {
      key: "ai-running",
      code,
      title: "等待当前 AI 任务结束",
      detail: "停止当前任务或等待执行完成，再重新检查旧工作区。",
    };
  }
  if (code === "WORKTREE_MUTATION_BUSY") {
    return {
      key: "worktree-busy",
      code,
      title: "等待工作区操作完成",
      detail: "当前工作区仍有受管变更操作，完成后再重新检查。",
    };
  }
  return {
    key: code,
    code,
    title: message,
    detail: "按提示处理后点击“重新检查”；预览通过前不会修改旧工作区。",
  };
}

export function legacyUpgradeBlockerGuidance(preview = {}) {
  const blockers = Array.isArray(preview?.blockers) ? preview.blockers : [];
  const controllerSetupMissing = blockers.some((blocker) => (
    CONTROLLER_SETUP_CODES.has(String(blocker?.code || ""))
  ));
  const seen = new Set();
  return blockers
    .filter((blocker) => !(
      controllerSetupMissing
      && String(blocker?.code || "") === "STORY_REPOSITORY_DEFINITION_REQUIRED"
    ))
    .map(blockerGuide)
    .filter((guide) => {
      if (seen.has(guide.key)) return false;
      seen.add(guide.key);
      return true;
    });
}

export function legacyUpgradeActionState(preview, {
  loading = false,
  upgrading = false,
} = {}) {
  const ready = preview?.canUpgrade === true && /^[0-9a-f]{64}$/i.test(
    String(preview?.previewToken || ""),
  );
  return {
    mode: ready ? "upgrade" : "explain",
    disabled: loading || upgrading || !preview,
    ready,
    label: upgrading
      ? "正在安全升级…"
      : ready
        ? "开始安全升级"
        : "查看升级前置条件",
  };
}

export function formatMigrationBytes(value) {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
