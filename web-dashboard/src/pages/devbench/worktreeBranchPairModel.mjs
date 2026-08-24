/**
 * 基仓 ↔ worktree 分支对应关系 — 前端展示模型
 */

export function roleLabel(role) {
  if (role === "primary") return "主工程";
  if (role === "webapp") return "WebApp";
  if (role === "extra") return "关联工程";
  return role || "工程";
}

export function hasBranchPairMismatches(report) {
  return !!report?.available && report?.ok === false && (report?.mismatchCount || 0) > 0;
}

export function branchPairHeadline(report) {
  const n = Number(report?.mismatchCount || 0);
  const issues = Number(report?.issueCount || 0);
  if (n <= 0) return "基仓与 worktree 分支对应正常";
  if (n === 1) return `发现 1 个工程的分支对应关系异常（${issues} 项）`;
  return `发现 ${n} 个工程的分支对应关系异常（共 ${issues} 项）`;
}

export function branchPairIssueTone(severity) {
  // 当前均为 warn；预留 error 级别配色
  return severity === "error" ? "error" : "warn";
}
