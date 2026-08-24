import * as store from "./store.js";
import { inspectGitCommitLatestBranch } from "./git-commit-story.js";

export async function refreshGitCommitLatestBranch(tabId, { force = false } = {}) {
  const tab = store.getTab(tabId);
  if (!tab) return { ok: false, code: "TAB_NOT_FOUND", error: "故事点不存在" };
  if (tab.reviewContext?.kind !== "git_commit") {
    return { ok: false, code: "GIT_COMMIT_REVIEW_REQUIRED", error: "该故事点不是 Git commit 评审类型" };
  }
  const previous = tab.reviewContext.latestBranchComparison;
  const previousCheckedAt = Date.parse(previous?.checkedAt || "");
  if (!force && Number.isFinite(previousCheckedAt) && Date.now() - previousCheckedAt < 30_000) {
    return { ok: true, cached: true, comparison: previous, data: tab };
  }

  const primary = store.getPrimaryProject(tab);
  const definition = store.getProjectDef(tab.reviewContext.repositoryId || tab.projectDefId);
  let comparison;
  try {
    comparison = await inspectGitCommitLatestBranch({
      repositoryPath: primary?.path || "",
      reviewContext: tab.reviewContext,
      remoteUrl: String(definition?.ssh || definition?.https || tab.reviewContext.repositoryUrl || "").trim(),
    });
  } catch {
    // 意外异常不得把仓库 URL、凭据或底层命令行原文持久化进故事点上下文。
    comparison = {
      ok: false,
      status: "unavailable",
      checkedAt: new Date().toISOString(),
      revision: String(tab.reviewContext.revision || "").trim(),
      comparisonReady: false,
      error: "最新分支复核失败，请检查仓库地址、网络或读取权限",
    };
  }
  const updated = store.updateTab(tab.id, {
    reviewContext: {
      ...tab.reviewContext,
      latestBranchComparison: comparison,
    },
  });
  return { ok: true, cached: false, comparison, data: updated };
}
