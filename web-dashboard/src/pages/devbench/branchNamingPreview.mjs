/**
 * 分支名「末尾 +1」前端预览（与 gateway/services/devbench/branch-naming.js 保持一致）：
 * 业务单号分支（…_CARB_14189）保持单号整体、追加/递增修正序号（…_CARB_14189 → …_CARB_14189_1；…_CARB_14189_1 → …_CARB_14189_2）；
 * 普通分支：末尾连续数字 +1（保留前导零）；无数字尾号直接追加 1。
 * 仅用于 UI 预览；真实可用名由后端按“已存在继续递增”推导。
 */
export function isBusinessTicketBranch(branch) {
  return /_CARB_\d+(?:_\d+)?$/i.test(branch || "");
}

export function branchPreview(branch) {
  if (!branch) return "";
  if (isBusinessTicketBranch(branch)) {
    const m = /_(\d+)$/.exec(branch);
    if (m) {
      const prefix = branch.slice(0, m.index);
      if (/\d$/.test(prefix)) return `${prefix}_${Number(m[1]) + 1}`;
    }
    return `${branch}_1`;
  }
  const m = /(\d+)$/.exec(branch);
  if (!m) return `${branch}1`;
  const digits = m[1];
  const padded = String(Number(digits) + 1).padStart(digits.length, "0");
  return `${branch.slice(0, m.index)}${padded}`;
}
