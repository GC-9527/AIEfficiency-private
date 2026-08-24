/**
 * 分支名「末尾 +1」推导 —— Amend 本地改动 / Git 提交整理共用。
 *
 * 规则：
 * - 普通分支：末尾连续数字 +1，保留前导零风格
 *   （feature/abc → feature/abc1；feature/login9 → feature/login10；
 *    story/…_08051624471 → story/…_08051624472，时间戳类前导零不丢失）。
 * - 业务单号分支（…_CARB_14189）：CARB_<数字> 是一个整体单号，绝不递增单号数字；
 *   改为追加/递增修正序号（…_CARB_14189 → …_CARB_14189_1；…_CARB_14189_1 → …_CARB_14189_2）。
 */

/** 是否业务单号分支：…_CARB_<数字> 结尾（可带已生成的修正序号 _N）。 */
export function isBusinessTicketBranch(name) {
  return /_CARB_\d+(?:_\d+)?$/i.test(name || "");
}

export function nextBranchSuffix(name) {
  if (isBusinessTicketBranch(name)) {
    const m = /_(\d+)$/.exec(name);
    if (m) {
      const prefix = name.slice(0, m.index);
      // 前缀仍以数字结尾 = 末尾是修正序号段（_N）→ 序号 +1；否则是单号本身 → 追加 _1
      if (/\d$/.test(prefix)) return `${prefix}_${Number(m[1]) + 1}`;
    }
    return `${name}_1`;
  }
  const m = /(\d+)$/.exec(name || "");
  if (!m) return `${name}1`;
  const digits = m[1];
  const nextNum = Number(digits) + 1;
  const padded = String(nextNum).padStart(digits.length, "0");
  return `${name.slice(0, m.index)}${padded}`;
}
