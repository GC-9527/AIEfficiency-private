/**
 * 故事点基仓 ↔ worktree 分支对应关系检测。
 * 正常关系：worktree 基于创建时的 originalBranch，并检出登记的 story/ 分支；
 * 基仓与 worktree 本来就不会在同一分支（Git 限制），故不以“同名”为对应标准。
 */

function normBranch(value) {
  return String(value || "").trim();
}

/**
 * @param {object} pair
 * @returns {{ ok: boolean, issues: Array<object>, summary?: string }}
 */
export function evaluateWorktreeBranchPair(pair = {}) {
  const name = String(pair.name || "工程").trim() || "工程";
  const role = String(pair.role || "extra");
  const baseBranch = normBranch(pair.baseBranch);
  const worktreeBranch = normBranch(pair.worktreeBranch);
  const originalBranch = normBranch(pair.originalBranch);
  const expectedWorktreeBranch = normBranch(pair.expectedWorktreeBranch);
  const issues = [];

  if (pair.worktreeExists === false) {
    return { ok: true, issues: [], name, role };
  }

  if (pair.baseExists === false) {
    issues.push({
      code: "base_missing",
      severity: "warn",
      title: "基仓路径不可用",
      detail: `${name} 的基仓目录不存在，无法核对分支对应关系。`,
    });
  } else if (!baseBranch) {
    issues.push({
      code: "base_detached",
      severity: "warn",
      title: "基仓处于游离 HEAD",
      detail: `${name} 基仓当前未检出命名分支，与 worktree 的来源关系不明确。`,
    });
  } else if (originalBranch && baseBranch !== originalBranch) {
    issues.push({
      code: "base_branch_mismatch",
      severity: "warn",
      title: "基仓分支已偏离创建来源",
      detail: `创建 worktree 时基于「${originalBranch}」，基仓现在在「${baseBranch}」。`,
      expected: originalBranch,
      actual: baseBranch,
      side: "base",
    });
  }

  if (!worktreeBranch) {
    issues.push({
      code: "worktree_detached",
      severity: "warn",
      title: "worktree 处于游离 HEAD",
      detail: `${name} 的 worktree 未检出命名分支，可能不在本故事点登记分支上。`,
    });
  } else if (expectedWorktreeBranch && worktreeBranch !== expectedWorktreeBranch) {
    issues.push({
      code: "worktree_branch_mismatch",
      severity: "warn",
      title: "worktree 分支与登记不一致",
      detail: `本故事点登记为「${expectedWorktreeBranch}」，worktree 现在在「${worktreeBranch}」。`,
      expected: expectedWorktreeBranch,
      actual: worktreeBranch,
      side: "worktree",
    });
  }

  return {
    ok: issues.length === 0,
    issues,
    name,
    role,
    baseBranch,
    worktreeBranch,
    originalBranch,
    expectedWorktreeBranch,
  };
}

export function summarizeBranchPairIssues(results = []) {
  const mismatches = (Array.isArray(results) ? results : []).filter((row) => !row.ok);
  const issueCount = mismatches.reduce((sum, row) => sum + (row.issues?.length || 0), 0);
  return {
    ok: mismatches.length === 0,
    mismatchCount: mismatches.length,
    issueCount,
    mismatches,
  };
}

/**
 * 从 tab.worktree.entries 生成待检测配对清单（不含 inactive）。
 */
export function listWorktreeBranchPairSpecs(tab) {
  const entries = Array.isArray(tab?.worktree?.entries) ? tab.worktree.entries : [];
  if (!tab?.worktree?.managed) return [];
  return entries
    .filter((entry) => entry && entry.role !== "inactive" && entry.active !== false)
    .map((entry) => ({
      role: entry.role || "extra",
      name: entry.name || "工程",
      basePath: String(entry.baseRepositoryPath || entry.basePath || "").trim(),
      worktreePath: String(entry.worktreePath || entry.path || "").trim(),
      originalBranch: String(entry.originalBranch || "").trim(),
      expectedWorktreeBranch: String(entry.branch || "").trim(),
    }))
    .filter((spec) => spec.worktreePath || spec.basePath);
}
