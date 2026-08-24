function text(value) {
  return String(value || "").trim();
}

export function workspaceBundleSummary(worktree) {
  if (!worktree?.bundle?.enabled) return null;
  const members = (Array.isArray(worktree.entries) ? worktree.entries : [])
    .filter((entry) => entry && entry.active !== false && entry.role !== "inactive")
    .map((entry) => {
      const readOnly = entry.mode === "READ_ONLY";
      return {
        repositoryId: text(entry.repositoryId),
        name: text(entry.name || entry.repositoryId || "仓库"),
        directoryName: text(entry.checkoutDirName || entry.directoryName),
        branchLabel: readOnly ? "来源分支" : "工作分支",
        branch: text(readOnly ? (entry.logicalBranch || entry.originalBranch || entry.baseRef) : (entry.branch || entry.logicalBranch)),
        commit: text(entry.baseRevision).slice(0, 8),
        mode: readOnly ? "只读依赖" : "可修改",
        readOnly,
      };
    });
  return {
    workspaceId: text(worktree.workspaceId),
    root: text(worktree.root || worktree.bundle.root),
    logicalBranch: text(worktree.preflight?.logicalBranch || members.find((member) => member.repositoryId === worktree.bundle.buildEntryRepositoryId)?.branch),
    status: text(worktree.preflight?.status || "UNKNOWN"),
    buildValidation: {
      status: text(worktree.preflight?.buildValidation?.status || "UNKNOWN"),
      task: text(worktree.preflight?.buildValidation?.task || "projects"),
    },
    members,
  };
}
