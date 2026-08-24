/**
 * 三门控决策表（方案 §3.4，v3.3）
 *
 * 每条规则必须同时满足：
 *   Gate 1: TB 单描述匹配（tb_pattern）
 *   Gate 2: 日志模式匹配（log_pattern）
 *   Gate 3: 日志归属当前 case.package_name（可豁免系统级规则）
 *
 * 任一未满足：
 *   - 若部分命中：返回 weak_hint 供 LLM 作先验
 *   - 若完全未命中：返回 null
 */

export const PRIORITY_RULES = [
  {
    id: "R001-JavaCrash",
    tb_pattern: {
      any: [
        /崩溃|闪退|一打开就退|打开.*就(退出|关闭)/,
        /\bcrash|force\s*close/i,
      ],
    },
    log_pattern: /FATAL EXCEPTION/i,
    require_package_owned: true,
    target_category: "代码问题",
    target_sub_category: "Java Crash",
    base_confidence: 0.92,
  },
  {
    id: "R002-NativeCrash",
    tb_pattern: {
      any: [/崩溃|闪退|signal|tombstone/i],
    },
    log_pattern: /signal\s+\d+\s+\(SIG\w+\)|DEBUG\s*:\s*\*+\s*\*+/i,
    require_package_owned: true,
    target_category: "代码问题",
    target_sub_category: "Native Crash",
    base_confidence: 0.90,
  },
  {
    id: "R003-ANR",
    tb_pattern: {
      any: [/无响应|卡死|点了没反应|ANR/i],
    },
    log_pattern: /ANR in.+(?:Input dispatching timed out|not responding)/i,
    require_package_owned: true,
    target_category: "代码问题",
    target_sub_category: "ANR",
    base_confidence: 0.90,
  },
  {
    id: "R004-OOM",
    tb_pattern: {
      any: [/内存|OOM|out\s*of\s*memory|卡顿.*越用越|爆内存/i],
    },
    log_pattern: /OutOfMemoryError|lowmemorykiller/i,
    require_package_owned: true,
    target_category: "代码问题",
    target_sub_category: "OOM",
    base_confidence: 0.85,
  },
  {
    id: "R005-KernelPanic",
    tb_pattern: {
      any: [/设备重启|无法开机|花屏|系统卡死|boot\s*loop|黑屏|自动重启/i],
    },
    log_pattern: /Kernel panic|Hardware Error|HW\s+I\/O\s+error/i,
    require_package_owned: false, // 系统级
    target_category: "非问题",
    target_sub_category: "硬件故障",
    base_confidence: 0.95,
  },
  {
    id: "R006-Network",
    tb_pattern: {
      any: [/无网络|连不上网|断网|WiFi.*(不行|故障)|4G.*(断|连不上)/i],
    },
    log_pattern: /Network is unreachable|DNS_PROBE_FINISHED|ECONNREFUSED/i,
    require_package_owned: false,
    target_category: "非问题",
    target_sub_category: "网络环境",
    base_confidence: 0.80,
  },
  {
    id: "R007-PermissionDenied",
    tb_pattern: {
      any: [/没有权限|权限(拒绝|不足)|permission\s*denied/i],
    },
    log_pattern: /Permission Denial|SecurityException/i,
    require_package_owned: true,
    target_category: "代码问题",
    target_sub_category: "Runtime Permission",
    base_confidence: 0.80,
  },
  // UI 问题不在决策表中 —— 日志信号弱，完全交 LLM 判断
];

// ---------- matcher 工具 ----------

function matchAny(text, anyList) {
  if (!Array.isArray(anyList) || anyList.length === 0) return false;
  for (const p of anyList) {
    if (p instanceof RegExp && p.test(text)) return true;
  }
  return false;
}

/**
 * @param {Object} p
 * @param {string} p.tb_text - TB 单标题+正文 拼接
 * @param {Array<{text_snapshot:string, owner_package?:string, ownership_confidence?:number}>} p.evidences
 * @param {string} p.case_package
 * @returns {{ hit: boolean, rule?: Object, weak_hints: Array, all_results: Array }}
 */
export function evalPriorityRules({ tb_text, evidences, case_package }) {
  const ownEvidences = (evidences || []).filter((e) => {
    const owner = e.owner_package;
    const conf = e.ownership_confidence ?? 1.0;
    return !owner || owner === case_package || conf < 0.5;
  });

  const all_results = [];
  for (const rule of PRIORITY_RULES) {
    // require_package_owned=false 的系统级规则对全部 evidence 做日志匹配，
    // 否则只看归属当前包（或无法识别）的 evidence。
    const scopedEvidences = rule.require_package_owned ? ownEvidences : (evidences || []);
    const tb_ok = matchAny(tb_text || "", rule.tb_pattern?.any || []);
    const log_ok = scopedEvidences.some((e) => rule.log_pattern.test(e.text_snapshot || ""));
    const pkg_ok = !rule.require_package_owned ||
                   ownEvidences.some((e) => e.owner_package === case_package);

    const full = tb_ok && log_ok && pkg_ok;
    const weak = !full && (tb_ok || log_ok);
    all_results.push({ id: rule.id, tb_ok, log_ok, pkg_ok, hit: full, weak });

    if (full) {
      return { hit: true, rule, weak_hints: [], all_results };
    }
  }

  const weak_hints = all_results
    .filter((r) => r.weak)
    .map((r) => {
      const rule = PRIORITY_RULES.find((x) => x.id === r.id);
      return {
        id: rule.id,
        target_category: rule.target_category,
        target_sub_category: rule.target_sub_category,
        base_confidence: rule.base_confidence,
        hint: `${rule.id} 部分命中 (tb=${r.tb_ok}, log=${r.log_ok}, pkg=${r.pkg_ok})`,
      };
    });

  return { hit: false, weak_hints, all_results };
}
